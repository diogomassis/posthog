import { preloadedScenes } from 'scenes/scenes'
import { Scene } from 'scenes/sceneTypes'

import { productScenes } from '~/products'

export const appScenes: Record<Scene | string, () => any> = {
    [Scene.Error404]: () => ({ default: preloadedScenes[Scene.Error404].component }),
    [Scene.ErrorNetwork]: () => ({ default: preloadedScenes[Scene.ErrorNetwork].component }),
    [Scene.ErrorProjectUnavailable]: () => ({ default: preloadedScenes[Scene.ErrorProjectUnavailable].component }),
    ...productScenes,
    [Scene.NewTab]: () => import('./new-tab/NewTabScene'),
    [Scene.Dashboards]: () => import('./dashboard/dashboards/Dashboards'),
    [Scene.Dashboard]: () => import('./dashboard/Dashboard'),
    [Scene.Insight]: () => import('./insights/InsightScene'),
    [Scene.WebAnalytics]: () => import('./web-analytics/WebAnalyticsScene'),
    [Scene.WebAnalyticsWebVitals]: () => import('./web-analytics/WebAnalyticsScene'),
    [Scene.WebAnalyticsMarketing]: () => import('./web-analytics/WebAnalyticsScene'),
    [Scene.RevenueAnalytics]: () => import('products/revenue_analytics/frontend/RevenueAnalyticsScene'),
    [Scene.Cohort]: () => import('./cohorts/Cohort'),
    [Scene.DataManagement]: () => import('./data-management/DataManagementScene'),
    [Scene.Activity]: () => import('./activity/ActivityScene'),
    [Scene.EventDefinition]: () => import('./data-management/definition/DefinitionView'),
    [Scene.EventDefinitionEdit]: () => import('./data-management/definition/DefinitionEdit'),
    [Scene.PropertyDefinition]: () => import('./data-management/definition/DefinitionView'),
    [Scene.PropertyDefinitionEdit]: () => import('./data-management/definition/DefinitionEdit'),
    [Scene.Replay]: () => import('./session-recordings/SessionRecordings'),
    [Scene.ReplaySingle]: () => import('./session-recordings/detail/SessionRecordingDetail'),
    [Scene.ReplayPlaylist]: () => import('./session-recordings/playlist/SessionRecordingsPlaylistScene'),
    [Scene.ReplayFilePlayback]: () => import('./session-recordings/file-playback/SessionRecordingFilePlaybackScene'),
    [Scene.ReplaySettings]: () => import('./session-recordings/settings/SessionRecordingsSettingsScene'),
    [Scene.PersonsManagement]: () => import('./persons-management/PersonsManagementScene'),
    [Scene.Person]: () => import('./persons/PersonScene'),
    [Scene.PipelineNodeNew]: () => import('./pipeline/PipelineNodeNew'),
    [Scene.Pipeline]: () => import('./pipeline/Pipeline'),
    [Scene.PipelineNode]: () => import('./pipeline/PipelineNode'),
    [Scene.Groups]: () => import('./groups/Groups'),
    [Scene.GroupsNew]: () => import('./groups/GroupsNew'),
    [Scene.Group]: () => import('./groups/Group'),
    [Scene.Action]: () => import('./actions/Action'),
    [Scene.Experiments]: () => import('./experiments/Experiments'),
    [Scene.ExperimentsSharedMetrics]: () => import('./experiments/SharedMetrics/SharedMetrics'),
    [Scene.ExperimentsSharedMetric]: () => import('./experiments/SharedMetrics/SharedMetric'),
    [Scene.Experiment]: () => import('./experiments/Experiment'),
    [Scene.FeatureFlags]: () => import('./feature-flags/FeatureFlags'),
    [Scene.FeatureFlag]: () => import('./feature-flags/FeatureFlag'),
    [Scene.Surveys]: () => import('./surveys/Surveys'),
    [Scene.Survey]: () => import('./surveys/Survey'),
    [Scene.CustomCss]: () => import('./themes/CustomCssScene'),
    [Scene.SurveyTemplates]: () => import('./surveys/SurveyTemplates'),
    [Scene.SQLEditor]: () => import('./data-warehouse/editor/EditorScene'),
    [Scene.OrganizationCreateFirst]: () => import('./organization/Create'),
    [Scene.OrganizationCreationConfirm]: () => import('./organization/ConfirmOrganization/ConfirmOrganization'),
    [Scene.ProjectHomepage]: () => import('./project-homepage/ProjectHomepage'),
    [Scene.Max]: () => import('./max/Max'),
    [Scene.ProjectCreateFirst]: () => import('./project/Create'),
    [Scene.SystemStatus]: () => import('./instance/SystemStatus'),
    [Scene.ToolbarLaunch]: () => import('./toolbar-launch/ToolbarLaunch'),
    [Scene.Site]: () => import('./sites/Site'),
    [Scene.AsyncMigrations]: () => import('./instance/AsyncMigrations/AsyncMigrations'),
    [Scene.DeadLetterQueue]: () => import('./instance/DeadLetterQueue/DeadLetterQueue'),
    [Scene.PreflightCheck]: () => import('./PreflightCheck/PreflightCheck'),
    [Scene.Signup]: () => import('./authentication/signup/SignupContainer'),
    [Scene.InviteSignup]: () => import('./authentication/InviteSignup'),
    [Scene.Billing]: () => import('./billing/Billing'),
    [Scene.BillingSection]: () => import('./billing/BillingSection'),
    [Scene.BillingAuthorizationStatus]: () => import('./billing/AuthorizationStatus'),
    [Scene.Login]: () => import('./authentication/Login'),
    [Scene.Login2FA]: () => import('./authentication/Login2FA'),
    [Scene.SavedInsights]: () => import('./saved-insights/SavedInsights'),
    [Scene.PasswordReset]: () => import('./authentication/PasswordReset'),
    [Scene.PasswordResetComplete]: () => import('./authentication/PasswordResetComplete'),
    [Scene.Unsubscribe]: () => import('./Unsubscribe/Unsubscribe'),
    [Scene.IntegrationsRedirect]: () => import('./IntegrationsRedirect/IntegrationsRedirect'),
    [Scene.DebugQuery]: () => import('./debug/DebugScene'),
    [Scene.DebugHog]: () => import('./debug/hog/HogRepl'),
    [Scene.VerifyEmail]: () => import('./authentication/signup/verify-email/VerifyEmail'),
    [Scene.Notebooks]: () => import('./notebooks/NotebooksScene'),
    [Scene.Notebook]: () => import('./notebooks/NotebookScene'),
    [Scene.Canvas]: () => import('./notebooks/NotebookCanvasScene'),
    [Scene.Products]: () => import('./products/Products'),
    [Scene.Onboarding]: () => import('./onboarding/Onboarding'),
    [Scene.Settings]: () => import('./settings/SettingsScene'),
    [Scene.MoveToPostHogCloud]: () => import('./moveToPostHogCloud/MoveToPostHogCloud'),
    [Scene.Heatmaps]: () => import('./heatmaps/HeatmapsScene'),
    [Scene.SessionAttributionExplorer]: () =>
        import('scenes/web-analytics/SessionAttributionExplorer/SessionAttributionExplorerScene'),
    [Scene.Wizard]: () => import('./wizard/Wizard'),
    [Scene.StartupProgram]: () => import('./startups/StartupProgram'),
    [Scene.OAuthAuthorize]: () => import('./oauth/OAuthAuthorize'),
    [Scene.HogFunction]: () => import('./hog-functions/HogFunctionScene'),
    [Scene.DataPipelines]: () => import('./data-pipelines/DataPipelinesScene'),
    [Scene.DataPipelinesNew]: () => import('./data-pipelines/DataPipelinesNewScene'),
    [Scene.DataWarehouse]: () => import('./data-warehouse/DataWarehouseScene'),
    [Scene.DataWarehouseSource]: () => import('./data-warehouse/settings/DataWarehouseSourceScene'),
    [Scene.DataWarehouseSourceNew]: () => import('./data-warehouse/new/NewSourceWizard'),
    [Scene.BatchExport]: () => import('./data-pipelines/batch-exports/BatchExportScene'),
    [Scene.BatchExportNew]: () => import('./data-pipelines/batch-exports/BatchExportScene'),
    [Scene.LegacyPlugin]: () => import('./data-pipelines/legacy-plugins/LegacyPluginScene'),
}
