import hashlib
import re
import time
from functools import lru_cache
from typing import Optional
from django.conf import settings
from prometheus_client import Counter
from rest_framework.throttling import SimpleRateThrottle, BaseThrottle, UserRateThrottle
from rest_framework.request import Request

from posthog.event_usage import report_user_action
from posthog.exceptions_capture import capture_exception
from statshog.defaults.django import statsd
from posthog.auth import PersonalAPIKeyAuthentication
from posthog.metrics import LABEL_PATH, LABEL_TEAM_ID
from posthog.models.instance_setting import get_instance_setting
from posthog.models.team.team import Team
from posthog.settings.utils import get_list
from token_bucket import Limiter, MemoryStorage
from posthog.models.personal_api_key import hash_key_value

RATE_LIMIT_EXCEEDED_COUNTER = Counter(
    "rate_limit_exceeded_total",
    "Dropped requests due to rate-limiting, per team_id, scope and path.",
    labelnames=[LABEL_TEAM_ID, "scope", LABEL_PATH],
)

RATE_LIMIT_BYPASSED_COUNTER = Counter(
    "rate_limit_bypassed_total",
    "Requests that should be dropped by rate-limiting but allowed by configuration.",
    labelnames=[LABEL_TEAM_ID, LABEL_PATH],
)

DECIDE_RATE_LIMIT_EXCEEDED_COUNTER = Counter(
    "decide_rate_limit_exceeded_total",
    "Dropped requests due to rate-limiting, per token.",
    labelnames=["token"],
)


@lru_cache(maxsize=1)
def get_team_allow_list(_ttl: int) -> list[str]:
    """
    The "allow list" will change way less frequently than it will be called
    _ttl is passed an infrequently changing value to ensure the cache is invalidated after some delay
    """
    return get_list(get_instance_setting("RATE_LIMITING_ALLOW_LIST_TEAMS"))


def team_is_allowed_to_bypass_throttle(team_id: Optional[int]) -> bool:
    """
    Check if a given team_id belongs to a throttle bypass allow list.
    """
    allow_list = get_team_allow_list(round(time.time() / 60))
    return team_id is not None and str(team_id) in allow_list


@lru_cache(maxsize=1)
def is_rate_limit_enabled(_ttl: int) -> bool:
    """
    The setting will change way less frequently than it will be called
    _ttl is passed an infrequently changing value to ensure the cache is invalidated after some delay
    """
    return get_instance_setting("RATE_LIMIT_ENABLED")


def is_decide_rate_limit_enabled() -> bool:
    """
    The setting will change way less frequently than it will be called
    _ttl is passed an infrequently changing value to ensure the cache is invalidated after some delay
    """
    from django.conf import settings
    from posthog.utils import str_to_bool

    return str_to_bool(settings.DECIDE_RATE_LIMIT_ENABLED)


path_by_team_pattern = re.compile(r"/api/projects/(\d+)/")
path_by_org_pattern = re.compile(r"/api/organizations/(.+)/")


class PersonalApiKeyRateThrottle(SimpleRateThrottle):
    @staticmethod
    def safely_get_team_id_from_view(view):
        """
        Gets the team_id from a view without throwing.

        Not all views have a team_id (e.g. the /organization endpoints),
        and accessing it when it does not exist throws a KeyError. Hence, this method.
        """
        try:
            return getattr(view, "team_id", None)
        except KeyError:
            return None

    def load_team_rate_limit(self, team_id):
        # try loading from cache
        rate_limit_cache_key = f"team_ratelimit_{self.scope}_{team_id}"
        cached_rate_limit = self.cache.get(rate_limit_cache_key, None)
        if cached_rate_limit is not None:
            self.rate = cached_rate_limit
        else:
            team = Team.objects.get(id=team_id)
            if not team or not team.api_query_rate_limit:
                return
            self.rate = team.api_query_rate_limit
            self.cache.set(rate_limit_cache_key, self.rate)

        self.num_requests, self.duration = self.parse_rate(self.rate)

    def allow_request(self, request, view):
        if not is_rate_limit_enabled(round(time.time() / 60)):
            return True

        # Only rate limit authenticated requests made with a personal API key
        personal_api_key = PersonalAPIKeyAuthentication.find_key_with_source(request)
        if request.user.is_authenticated and personal_api_key is None:
            return True

        try:
            team_id = self.safely_get_team_id_from_view(view)
            if team_id is not None and self.scope == HogQLQueryThrottle.scope:
                self.load_team_rate_limit(team_id)

            request_would_be_allowed = super().allow_request(request, view)
            if request_would_be_allowed:
                return True

            path = getattr(request, "path", None)
            if path:
                path = path_by_team_pattern.sub("/api/projects/TEAM_ID/", path)
                path = path_by_org_pattern.sub("/api/organizations/ORG_ID/", path)

            if team_is_allowed_to_bypass_throttle(team_id):
                statsd.incr(
                    "team_allowed_to_bypass_rate_limit_exceeded",
                    tags={"team_id": team_id, "path": path},
                )
                RATE_LIMIT_BYPASSED_COUNTER.labels(team_id=team_id, path=path).inc()
                return True
            else:
                scope = getattr(self, "scope", None)
                rate = getattr(self, "rate", None)

                statsd.incr(
                    "rate_limit_exceeded",
                    tags={
                        "team_id": team_id,
                        "scope": scope,
                        "rate": rate,
                        "path": path,
                        "hashed_personal_api_key": hash_key_value(personal_api_key[0]) if personal_api_key else None,
                    },
                )
                RATE_LIMIT_EXCEEDED_COUNTER.labels(team_id=team_id, scope=scope, path=path).inc()

            return False
        except Team.DoesNotExist as e:
            capture_exception(e)
            return False
        except Exception as e:
            capture_exception(e)
            return True

    def get_cache_key(self, request, view):
        """
        Tries the following options in order:
        - personal_api_key
        - team_id
        - user_id
        - ip
        """
        ident = None
        if request.user.is_authenticated:
            api_key = PersonalAPIKeyAuthentication.find_key_with_source(request)
            if api_key is not None:
                ident = hash_key_value(api_key[0])
            else:
                try:
                    team_id = self.safely_get_team_id_from_view(view)
                    if team_id:
                        ident = team_id
                    else:
                        ident = request.user.pk
                except Exception as e:
                    capture_exception(e)
                    ident = self.get_ident(request)
        else:
            ident = self.get_ident(request)

        return self.cache_format % {"scope": self.scope, "ident": ident}


class DecideRateThrottle(BaseThrottle):
    """
    This is a custom throttle that is used to limit the number of requests to the /decide endpoint.
    It is different from the PersonalApiKeyRateThrottle in that it does not use the Django cache, but instead
    uses the Limiter from the `token-bucket` library.
    This uses the token bucket algorithm to limit the number of requests to the endpoint. It's a lot
    more performant than DRF's SimpleRateThrottle, which inefficiently uses the Django cache.

    However, note that this throttle is per process, and not global.
    """

    def __init__(self, replenish_rate: float = 5, bucket_capacity=100) -> None:
        self.limiter = Limiter(
            rate=replenish_rate,
            capacity=bucket_capacity,
            storage=MemoryStorage(),
        )

    @staticmethod
    def safely_get_token_from_request(request: Request) -> Optional[str]:
        """
        Gets the token from a request without throwing.

        Not all requests are valid, and might not have a token.
        Accessing it when it does not exist throws a KeyError. Hence, this method.
        """
        try:
            from posthog.api.utils import get_token
            from posthog.utils import load_data_from_request

            if request.method != "POST":
                return None

            data = load_data_from_request(request)
            return get_token(data, request)
        except Exception:
            return None

    def allow_request(self, request, view):
        if not is_decide_rate_limit_enabled():
            return True

        try:
            bucket_key = self.get_bucket_key(request)
            request_would_be_allowed = self.limiter.consume(bucket_key)

            if not request_would_be_allowed:
                DECIDE_RATE_LIMIT_EXCEEDED_COUNTER.labels(token=bucket_key).inc()

            return request_would_be_allowed
        except Exception as e:
            capture_exception(e)
            return True

    def get_bucket_key(self, request):
        """
        Attempts to throttle based on the team_id of the request. If it can't do that, it falls back to the user_id.
        And then finally to the IP address.
        """
        ident = None
        token = self.safely_get_token_from_request(request)
        if token:
            ident = token
        else:
            ident = self.get_ident(request)

        return ident


class UserOrEmailRateThrottle(SimpleRateThrottle):
    """
    Typically throttling is on the user or the IP address.
    For unauthenticated signup/login requests we want to throttle on the email address.
    """

    scope = "user"

    def get_cache_key(self, request, view):
        if request.user and request.user.is_authenticated:
            ident = request.user.pk
        else:
            # For unauthenticated requests, we want to throttle on something unique to the user they are trying to work with
            # This could be email for example when logging in or uuid when verifying email
            ident = request.data.get("email") or request.data.get("uuid") or self.get_ident(request)
            ident = hashlib.sha256(ident.encode()).hexdigest()

        return self.cache_format % {"scope": self.scope, "ident": ident}


class SignupIPThrottle(SimpleRateThrottle):
    """
    Rate limit signups by IP address to avoid a single IP address from creating too many accounts.
    """

    scope = "signup_ip"
    rate = "5/day"

    def get_cache_key(self, request, view):
        from posthog.utils import get_ip_address

        ip = get_ip_address(request)
        return self.cache_format % {"scope": self.scope, "ident": ip}


class BurstRateThrottle(PersonalApiKeyRateThrottle):
    # Throttle class that's applied on all endpoints (except for capture + decide)
    # Intended to block quick bursts of requests, per project
    scope = "burst"
    rate = "480/minute"


class SustainedRateThrottle(PersonalApiKeyRateThrottle):
    # Throttle class that's applied on all endpoints (except for capture + decide)
    # Intended to block slower but sustained bursts of requests, per project
    scope = "sustained"
    rate = "4800/hour"


class ClickHouseBurstRateThrottle(PersonalApiKeyRateThrottle):
    # Throttle class that's a bit more aggressive and is used specifically on endpoints that hit ClickHouse
    # Intended to block quick bursts of requests, per project
    scope = "clickhouse_burst"
    rate = "240/minute"


class ClickHouseSustainedRateThrottle(PersonalApiKeyRateThrottle):
    # Throttle class that's a bit more aggressive and is used specifically on endpoints that hit ClickHouse
    # Intended to block slower but sustained bursts of requests, per project
    scope = "clickhouse_sustained"
    rate = "1200/hour"


class AIBurstRateThrottle(UserRateThrottle):
    # Throttle class that's very aggressive and is used specifically on endpoints that hit OpenAI
    # Intended to block quick bursts of requests, per user
    scope = "ai_burst"
    rate = "10/minute"

    def allow_request(self, request, view):
        request_allowed = super().allow_request(request, view)

        if not request_allowed and request.user.is_authenticated:
            report_user_action(request.user, "ai burst rate limited")

        return request_allowed


class AISustainedRateThrottle(UserRateThrottle):
    # Throttle class that's very aggressive and is used specifically on endpoints that hit OpenAI
    # Intended to block slower but sustained bursts of requests, per user
    scope = "ai_sustained"
    rate = "100/day"

    def allow_request(self, request, view):
        request_allowed = super().allow_request(request, view)

        if not request_allowed and request.user.is_authenticated:
            report_user_action(request.user, "ai sustained rate limited")

        return request_allowed


class LLMProxyBurstRateThrottle(UserRateThrottle):
    scope = "llm_proxy_burst"
    rate = "30/minute"


class LLMProxySustainedRateThrottle(UserRateThrottle):
    # Throttle class that's very aggressive and is used specifically on endpoints that hit OpenAI
    # Intended to block slower but sustained bursts of requests, per user
    scope = "llm_proxy_sustained"
    rate = "500/hour"


class HogQLQueryThrottle(PersonalApiKeyRateThrottle):
    # Lower rate limit for HogQL queries
    scope = "query"
    rate = "120/hour"


class APIQueriesBurstThrottle(PersonalApiKeyRateThrottle):
    scope = "api_queries_burst"
    rate = "120/minute"


class APIQueriesSustainedThrottle(PersonalApiKeyRateThrottle):
    scope = "api_queries_sustained"
    rate = "1200/hour"


class WebAnalyticsAPIBurstThrottle(PersonalApiKeyRateThrottle):
    scope = "web_analytics_api_burst"
    rate = "240/minute"


class WebAnalyticsAPISustainedThrottle(PersonalApiKeyRateThrottle):
    scope = "web_analytics_api_sustained"
    rate = "2400/hour"


class UserPasswordResetThrottle(UserOrEmailRateThrottle):
    scope = "user_password_reset"
    rate = "6/day"


class UserAuthenticationThrottle(UserOrEmailRateThrottle):
    scope = "user_authentication"
    rate = "5/minute"

    def allow_request(self, request, view):
        # only throttle non-GET requests
        if request.method == "GET":
            return True

        # only throttle if attempting to change current password
        if "current_password" not in request.data:
            return True

        return super().allow_request(request, view)


class UserEmailVerificationThrottle(UserOrEmailRateThrottle):
    scope = "user_email_verification"
    rate = "6/day"


class SetupWizardAuthenticationRateThrottle(UserRateThrottle):
    # Throttle class that is applied for authenticating the setup wizard
    # This is more aggressive than other throttles because the wizard makes LLM calls
    scope = "wizard_authentication"
    rate = "20/day"


class SetupWizardQueryRateThrottle(SimpleRateThrottle):
    def get_rate(self):
        if settings.DEBUG:
            return "1000/day"
        return "20/day"

    # Throttle per wizard hash
    def get_cache_key(self, request, view):
        hash = request.headers.get("X-PostHog-Wizard-Hash")

        if not hash:
            return self.get_ident(request)
        return f"throttle_wizard_query_{hash}"


class BreakGlassBurstThrottle(UserOrEmailRateThrottle):
    # Throttle class that can be applied when a bug is causing too many requests to hit and an endpoint, e.g. a bug in the frontend hitting an endpoint in a loop.
    # Prefer making a subclass of this for specific endpoints, and setting a scope
    rate = "15/minute"


class BreakGlassSustainedThrottle(UserOrEmailRateThrottle):
    # Throttle class that can be applied when a bug is causing too many requests to hit and an endpoint, e.g. a bug in the frontend hitting an endpoint in a loop
    # Prefer making a subclass of this for specific endpoints, and setting a scope
    rate = "75/hour"
