import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { beforeUnload } from 'kea-router'
import { dayjs } from 'lib/dayjs'
import { objectsEqual } from 'lib/utils'
import { dataWarehouseSettingsLogic } from 'scenes/data-warehouse/settings/dataWarehouseSettingsLogic'
import { teamLogic } from 'scenes/teamLogic'

import {
    CurrencyCode,
    DataTableNode,
    NodeKind,
    RevenueAnalyticsConfig,
    RevenueAnalyticsEventItem,
    RevenueAnalyticsGoal,
    RevenueCurrencyPropertyConfig,
} from '~/queries/schema/schema-general'
import { ExternalDataSource } from '~/types'

import type { revenueAnalyticsSettingsLogicType } from './revenueAnalyticsSettingsLogicType'
import { databaseTableListLogic } from 'scenes/data-management/database/databaseTableListLogic'

const createEmptyConfig = (): RevenueAnalyticsConfig => ({
    events: [],
    goals: [],
    filter_test_accounts: false,
})

const sortByDueDate = (goals: RevenueAnalyticsGoal[]): RevenueAnalyticsGoal[] => {
    return goals.sort((a, b) => dayjs(a.due_date).diff(dayjs(b.due_date)))
}

type PropertyUpdater<T extends keyof RevenueAnalyticsEventItem> = {
    eventName: string
    property: RevenueAnalyticsEventItem[T]
}
const updateStatePropertyBuilder =
    (propertyKey: keyof RevenueAnalyticsEventItem) =>
    (state: RevenueAnalyticsConfig | null, { eventName, property }: PropertyUpdater<typeof propertyKey>) => {
        if (!state) {
            return state
        }

        return {
            ...state,
            events: state.events.map((item) => {
                if (item.eventName === eventName) {
                    return { ...item, [propertyKey]: property }
                }
                return item
            }),
        }
    }

export const revenueAnalyticsSettingsLogic = kea<revenueAnalyticsSettingsLogicType>([
    path(['scenes', 'data-management', 'revenue', 'revenueAnalyticsSettingsLogic']),
    connect(() => ({
        values: [
            teamLogic,
            ['currentTeam', 'currentTeamId'],
            dataWarehouseSettingsLogic,
            ['dataWarehouseSources'],
            databaseTableListLogic,
            ['database'],
        ],
        actions: [teamLogic, ['updateCurrentTeam'], dataWarehouseSettingsLogic, ['updateSource']],
    })),
    actions({
        addEvent: (eventName: string, revenueCurrency: CurrencyCode) => ({ eventName, revenueCurrency }),
        deleteEvent: (eventName: string) => ({ eventName }),
        updateEventRevenueProperty: (eventName: string, property: string) => ({ eventName, property }),
        updateEventProductProperty: (eventName: string, property: string) => ({ eventName, property }),
        updateEventCouponProperty: (eventName: string, property: string) => ({ eventName, property }),
        updateEventCurrencyProperty: (eventName: string, property: RevenueCurrencyPropertyConfig) => ({
            eventName,
            property,
        }),
        updateEventCurrencyAwareDecimalProperty: (eventName: string, property: boolean) => ({
            eventName,
            property,
        }),

        addGoal: (goal: RevenueAnalyticsGoal) => ({ goal }),
        deleteGoal: (index: number) => ({ index }),
        updateGoal: (index: number, goal: RevenueAnalyticsGoal) => ({ index, goal }),

        updateFilterTestAccounts: (filterTestAccounts: boolean) => ({ filterTestAccounts }),

        save: true,
        resetConfig: true,
    }),
    reducers(({ values }) => ({
        revenueAnalyticsConfig: [
            null as RevenueAnalyticsConfig | null,
            {
                addEvent: (state: RevenueAnalyticsConfig | null, { eventName, revenueCurrency }) => {
                    if (!state || !eventName || typeof eventName !== 'string') {
                        return state
                    }

                    const existingEvents = new Set(
                        state.events.map((item: RevenueAnalyticsEventItem) => item.eventName)
                    )
                    if (existingEvents.has(eventName)) {
                        return state
                    }

                    return {
                        ...state,
                        events: [
                            ...state.events,
                            {
                                eventName,
                                revenueProperty: '',
                                revenueCurrencyProperty: { static: revenueCurrency },
                                currencyAwareDecimal: false,
                            },
                        ],
                    }
                },
                deleteEvent: (state: RevenueAnalyticsConfig | null, { eventName }) => {
                    if (!state) {
                        return state
                    }
                    return { ...state, events: state.events.filter((item) => item.eventName !== eventName) }
                },

                updateEventCouponProperty: updateStatePropertyBuilder('couponProperty'),
                updateEventCurrencyAwareDecimalProperty: updateStatePropertyBuilder('currencyAwareDecimal'),
                updateEventCurrencyProperty: updateStatePropertyBuilder('revenueCurrencyProperty'),
                updateEventProductProperty: updateStatePropertyBuilder('productProperty'),
                updateEventRevenueProperty: updateStatePropertyBuilder('revenueProperty'),

                addGoal: (state: RevenueAnalyticsConfig | null, { goal }) => {
                    if (!state) {
                        return state
                    }

                    const goals = sortByDueDate([...state.goals, goal])
                    return { ...state, goals }
                },
                deleteGoal: (state: RevenueAnalyticsConfig | null, { index }) => {
                    if (!state) {
                        return state
                    }

                    const goals = sortByDueDate(state.goals.filter((_, i) => i !== index))

                    return { ...state, goals }
                },
                updateGoal: (state: RevenueAnalyticsConfig | null, { index, goal }) => {
                    if (!state) {
                        return state
                    }

                    const goals = sortByDueDate(state.goals.map((item, i) => (i === index ? goal : item)))
                    return { ...state, goals }
                },
                updateFilterTestAccounts: (state: RevenueAnalyticsConfig | null, { filterTestAccounts }) => {
                    if (!state) {
                        return state
                    }
                    return { ...state, filter_test_accounts: filterTestAccounts }
                },
                resetConfig: () => {
                    return values.savedRevenueAnalyticsConfig
                },
            },
        ],
        savedRevenueAnalyticsConfig: [
            // TODO: Check how to pass the preflight region here
            values.currentTeam?.revenue_analytics_config || createEmptyConfig(),
            {
                updateCurrentTeam: (_, { revenue_analytics_config }) => {
                    // TODO: Check how to pass the preflight region here
                    return revenue_analytics_config || createEmptyConfig()
                },
            },
        ],
    })),
    selectors({
        filterTestAccounts: [
            (s) => [s.revenueAnalyticsConfig],
            (revenueAnalyticsConfig: RevenueAnalyticsConfig | null) =>
                revenueAnalyticsConfig?.filter_test_accounts || false,
        ],

        goals: [
            (s) => [s.revenueAnalyticsConfig],
            (revenueAnalyticsConfig: RevenueAnalyticsConfig | null) => revenueAnalyticsConfig?.goals || [],
        ],

        events: [
            (s) => [s.revenueAnalyticsConfig],
            (revenueAnalyticsConfig: RevenueAnalyticsConfig | null) => revenueAnalyticsConfig?.events || [],
        ],
        changesMadeToEvents: [
            (s) => [s.revenueAnalyticsConfig, s.savedRevenueAnalyticsConfig],
            (config, savedConfig): boolean => {
                return !!config && !objectsEqual(config.events, savedConfig.events)
            },
        ],
        saveEventsDisabledReason: [
            (s) => [s.revenueAnalyticsConfig, s.changesMadeToEvents],
            (config, changesMade): string | null => {
                if (!config) {
                    return 'Loading...'
                }
                if (!changesMade) {
                    return 'No changes to save'
                }
                if (config.events.some((event) => !event.revenueProperty)) {
                    return 'Revenue property must be set'
                }

                return null
            },
        ],

        enabledDataWarehouseSources: [
            (s) => [s.dataWarehouseSources],
            (dataWarehouseSources: ExternalDataSource[]): ExternalDataSource[] => {
                return dataWarehouseSources?.filter((source) => source.revenue_analytics_enabled) ?? []
            },
        ],

        exampleEventsQuery: [
            (s) => [s.savedRevenueAnalyticsConfig],
            (revenueAnalyticsConfig: RevenueAnalyticsConfig | null) => {
                if (!revenueAnalyticsConfig) {
                    return null
                }

                const query: DataTableNode = {
                    kind: NodeKind.DataTableNode,
                    full: true,
                    showPropertyFilter: false,
                    source: {
                        kind: NodeKind.RevenueExampleEventsQuery,
                    },
                }

                return query
            },
        ],
        exampleDataWarehouseTablesQuery: [
            (s) => [s.savedRevenueAnalyticsConfig],
            (revenueAnalyticsConfig: RevenueAnalyticsConfig | null) => {
                if (!revenueAnalyticsConfig) {
                    return null
                }

                const query: DataTableNode = {
                    kind: NodeKind.DataTableNode,
                    full: true,
                    showPropertyFilter: false,
                    source: {
                        kind: NodeKind.RevenueExampleDataWarehouseTablesQuery,
                    },
                }

                return query
            },
        ],

        joins: [
            (s) => [s.database],
            (database) => {
                return database?.joins || []
            },
        ],
    }),
    listeners(({ actions, values }) => {
        const updateCurrentTeam = (): void => {
            if (values.revenueAnalyticsConfig) {
                actions.updateCurrentTeam({ revenue_analytics_config: values.revenueAnalyticsConfig })
            }
        }

        return {
            addGoal: updateCurrentTeam,
            deleteGoal: updateCurrentTeam,
            updateGoal: updateCurrentTeam,
            updateFilterTestAccounts: updateCurrentTeam,
            save: updateCurrentTeam,
        }
    }),
    loaders(({ values }) => ({
        revenueAnalyticsConfig: {
            loadRevenueAnalyticsConfig: async () => {
                if (values.currentTeam) {
                    return values.currentTeam.revenue_analytics_config || createEmptyConfig()
                }
                return null
            },
        },
    })),
    beforeUnload(({ actions, values }) => ({
        enabled: () => values.changesMadeToEvents,
        message: 'Changes you made will be discarded. Make sure you save your changes before leaving this page.',
        onConfirm: () => {
            actions.resetConfig()
        },
    })),
    afterMount(({ actions }) => {
        actions.loadRevenueAnalyticsConfig()
    }),
])
