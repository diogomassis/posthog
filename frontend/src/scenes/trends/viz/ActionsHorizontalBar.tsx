import { useValues } from 'kea'
import { useEffect, useState } from 'react'
import { insightLogic } from 'scenes/insights/insightLogic'
import { formatBreakdownLabel } from 'scenes/insights/utils'
import { datasetToActorsQuery } from 'scenes/trends/viz/datasetToActorsQuery'

import { cohortsModel } from '~/models/cohortsModel'
import { propertyDefinitionsModel } from '~/models/propertyDefinitionsModel'
import { ChartParams, GraphType } from '~/types'

import { InsightEmptyState } from '../../insights/EmptyStates'
import { LineGraph } from '../../insights/views/LineGraph/LineGraph'
import { openPersonsModal } from '../persons-modal/PersonsModal'
import { trendsDataLogic } from '../trendsDataLogic'

type DataSet = any

export function ActionsHorizontalBar({ showPersonsModal = true, context }: ChartParams): JSX.Element | null {
    const [data, setData] = useState<DataSet[] | null>(null)
    const [total, setTotal] = useState(0)

    const { cohorts } = useValues(cohortsModel)
    const { formatPropertyValueForDisplay } = useValues(propertyDefinitionsModel)

    const { insightProps } = useValues(insightLogic)
    const {
        indexedResults,
        labelGroupType,
        trendsFilter,
        formula,
        showValuesOnSeries,
        hasDataWarehouseSeries,
        querySource,
        breakdownFilter,
        hiddenLegendIndexes,
        getTrendsColor,
        theme,
    } = useValues(trendsDataLogic(insightProps))

    useEffect(() => {
        if (indexedResults) {
            const colorList = indexedResults.map(getTrendsColor)

            setData([
                {
                    labels: indexedResults.map((item) => item.label),
                    data: indexedResults.map((item) => item.aggregated_value),
                    actions: indexedResults.map((item) => item.action),
                    personsValues: indexedResults.map((item) => item.persons),
                    breakdownValues: indexedResults.map((item) => item.breakdown_value),
                    breakdownLabels: indexedResults.map((item) => {
                        return formatBreakdownLabel(
                            item.breakdown_value,
                            breakdownFilter,
                            cohorts?.results,
                            formatPropertyValueForDisplay,
                            undefined,
                            item.label
                        )
                    }),
                    compareLabels: indexedResults.map((item) => item.compare_label),
                    backgroundColor: colorList,
                    hoverBackgroundColor: colorList,
                    hoverBorderColor: colorList,
                    borderColor: colorList,
                    hoverBorderWidth: 10,
                    borderWidth: 1,
                },
            ])
            setTotal(indexedResults.reduce((prev, item) => prev + item.aggregated_value, 0))
        }
    }, [indexedResults, theme, breakdownFilter, cohorts?.results, formatPropertyValueForDisplay, getTrendsColor])

    return data && total > 0 ? (
        <LineGraph
            data-attr="trend-bar-value-graph"
            type={GraphType.HorizontalBar}
            tooltip={{
                showHeader: false,
                groupTypeLabel: context?.groupTypeLabel,
            }}
            labelGroupType={labelGroupType}
            datasets={data}
            labels={data[0].labels}
            hiddenLegendIndexes={hiddenLegendIndexes}
            showPersonsModal={showPersonsModal}
            trendsFilter={trendsFilter}
            formula={formula}
            showValuesOnSeries={showValuesOnSeries}
            onClick={
                context?.onDataPointClick || (showPersonsModal && !trendsFilter?.formula && !hasDataWarehouseSeries)
                    ? (point) => {
                          const { index, points } = point

                          const dataset = points.referencePoint.dataset
                          dataset.action = dataset.actions?.[index]

                          const label = dataset.labels?.[point.index]

                          if (context?.onDataPointClick) {
                              context.onDataPointClick(
                                  {
                                      breakdown: dataset.breakdownValues?.[index],
                                      compare: dataset.compareLabels?.[index],
                                  },
                                  indexedResults[0]
                              )
                              return
                          }

                          openPersonsModal({
                              title: label || '',
                              query: datasetToActorsQuery({ dataset, query: querySource!, index }),
                              additionalSelect: {
                                  value_at_data_point: 'event_count',
                                  matched_recordings: 'matched_recordings',
                              },
                              orderBy: ['event_count DESC, actor_id DESC'],
                          })
                      }
                    : undefined
            }
        />
    ) : (
        <InsightEmptyState />
    )
}
