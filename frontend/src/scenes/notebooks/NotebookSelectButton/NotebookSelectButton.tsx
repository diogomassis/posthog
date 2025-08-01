import { IconNotebook, IconPlus } from '@posthog/icons'
import { LemonDivider, LemonDropdown, ProfilePicture } from '@posthog/lemon-ui'
import { BuiltLogic, useActions, useValues } from 'kea'
import { AccessControlledLemonButton } from 'lib/components/AccessControlledLemonButton'
import { dayjs } from 'lib/dayjs'
import { IconWithCount } from 'lib/lemon-ui/icons'
import { LemonButton, LemonButtonProps } from 'lib/lemon-ui/LemonButton'
import { LemonInput } from 'lib/lemon-ui/LemonInput/LemonInput'
import { PopoverProps } from 'lib/lemon-ui/Popover'
import { getAppContext } from 'lib/utils/getAppContext'
import { ReactChild, ReactElement, useEffect } from 'react'
import { useNotebookNode } from 'scenes/notebooks/Nodes/NotebookNodeContext'
import {
    notebookSelectButtonLogic,
    NotebookSelectButtonLogicProps,
} from 'scenes/notebooks/NotebookSelectButton/notebookSelectButtonLogic'

import { notebooksModel, openNotebook } from '~/models/notebooksModel'
import { AccessControlLevel, AccessControlResourceType } from '~/types'

import { notebookNodeLogicType } from '../Nodes/notebookNodeLogicType'
import { notebookLogicType } from '../Notebook/notebookLogicType'
import { NotebookListItemType, NotebookTarget } from '../types'

export type NotebookSelectProps = NotebookSelectButtonLogicProps & {
    newNotebookTitle?: string
    onNotebookOpened?: (
        notebookLogic: BuiltLogic<notebookLogicType>,
        nodeLogic?: BuiltLogic<notebookNodeLogicType>
    ) => void
}

export type NotebookSelectPopoverProps = NotebookSelectProps &
    Partial<Omit<PopoverProps, 'children'>> & {
        children: ReactElement
    }

export type NotebookSelectButtonProps = NotebookSelectProps &
    Omit<LemonButtonProps, 'onClick' | 'children' | 'sideAction'> & {
        onClick?: () => void
        children?: ReactChild
    }

function NotebooksChoiceList(props: {
    notebooks: NotebookListItemType[]
    emptyState: string
    onClick: (notebookShortId: NotebookListItemType['short_id']) => void
}): JSX.Element {
    return (
        <div>
            {props.notebooks.length === 0 ? (
                <div className="px-2 py-1">{props.emptyState}</div>
            ) : (
                props.notebooks.map((notebook, i) => {
                    return (
                        <LemonButton
                            key={i}
                            sideIcon={
                                notebook.created_by ? (
                                    <ProfilePicture
                                        user={notebook.created_by}
                                        size="md"
                                        title={`Created by ${notebook.created_by?.first_name} <${notebook.created_by?.email}>`}
                                    />
                                ) : null
                            }
                            fullWidth
                            onClick={() => props.onClick(notebook.short_id)}
                        >
                            <span className="truncate">{notebook.title || `Untitled (${notebook.short_id})`}</span>
                        </LemonButton>
                    )
                })
            )}
        </div>
    )
}

export function NotebookSelectList(props: NotebookSelectProps): JSX.Element {
    const logic = notebookSelectButtonLogic({ ...props })

    const { resource, newNotebookTitle } = props
    const notebookResource = resource && typeof resource !== 'boolean' ? resource : null
    const { notebooksLoading, notebooksContainingResource, notebooksNotContainingResource, searchQuery } =
        useValues(logic)
    const { setShowPopover, setSearchQuery, loadNotebooksContainingResource, loadAllNotebooks } = useActions(logic)
    const { createNotebook } = useActions(notebooksModel)

    const openAndAddToNotebook = (notebookShortId: string, exists: boolean): void => {
        const position = props.resource ? 'end' : 'start'
        void openNotebook(notebookShortId, NotebookTarget.Popover, position, (theNotebookLogic) => {
            if (!exists && props.resource) {
                theNotebookLogic.actions.insertAfterLastNode([props.resource])
            }
            props.onNotebookOpened?.(theNotebookLogic)
        })
    }

    const openNewNotebook = (): void => {
        const title = newNotebookTitle ?? `Notes ${dayjs().format('DD/MM')}`

        createNotebook(
            NotebookTarget.Popover,
            title,
            notebookResource ? [notebookResource] : undefined,
            (theNotebookLogic) => {
                props.onNotebookOpened?.(theNotebookLogic)
                loadNotebooksContainingResource()
            }
        )

        setShowPopover(false)
    }

    useEffect(() => {
        if (props.resource) {
            loadNotebooksContainingResource()
        }
        loadAllNotebooks()
        // oxlint-disable-next-line exhaustive-deps
    }, [loadAllNotebooks])

    return (
        <div className="flex flex-col flex-1 h-full overflow-hidden">
            <div className="deprecated-space-y-2 flex-0">
                <LemonInput
                    type="search"
                    placeholder="Search notebooks..."
                    value={searchQuery}
                    onChange={(s) => setSearchQuery(s)}
                    fullWidth
                />
                <AccessControlledLemonButton
                    data-attr="notebooks-select-button-create"
                    fullWidth
                    icon={<IconPlus />}
                    onClick={openNewNotebook}
                    resourceType={AccessControlResourceType.Notebook}
                    minAccessLevel={AccessControlLevel.Editor}
                    userAccessLevel={getAppContext()?.resource_access_control?.[AccessControlResourceType.Notebook]}
                >
                    New notebook
                </AccessControlledLemonButton>
                <LemonButton
                    fullWidth
                    onClick={() => {
                        setShowPopover(false)
                        openAndAddToNotebook('scratchpad', false)
                    }}
                >
                    My scratchpad
                </LemonButton>
            </div>
            <LemonDivider />
            <div className="overflow-y-auto flex-1">
                {notebooksLoading && !notebooksNotContainingResource.length && !notebooksContainingResource.length ? (
                    <div className="px-2 py-1 flex flex-row items-center deprecated-space-x-1">
                        {notebooksLoading ? (
                            'Loading...'
                        ) : searchQuery.length ? (
                            <>No matching notebooks</>
                        ) : (
                            <>You have no notebooks</>
                        )}
                    </div>
                ) : (
                    <>
                        {resource ? (
                            <>
                                <h5>Continue in</h5>
                                <NotebooksChoiceList
                                    notebooks={notebooksContainingResource}
                                    emptyState={
                                        searchQuery.length ? 'No matching notebooks' : 'Not already in any notebooks'
                                    }
                                    onClick={(notebookShortId) => {
                                        setShowPopover(false)
                                        openAndAddToNotebook(notebookShortId, true)
                                    }}
                                />
                                <LemonDivider />
                            </>
                        ) : null}
                        {resource ? <h5>Add to</h5> : null}
                        <NotebooksChoiceList
                            notebooks={notebooksNotContainingResource}
                            emptyState={searchQuery.length ? 'No matching notebooks' : "You don't have any notebooks"}
                            onClick={(notebookShortId) => {
                                setShowPopover(false)
                                openAndAddToNotebook(notebookShortId, false)
                            }}
                        />
                    </>
                )}
            </div>
        </div>
    )
}

export function NotebookSelectPopover({
    // so we can pass props to the button below, without passing visible to it
    visible,
    children,
    ...props
}: NotebookSelectPopoverProps): JSX.Element {
    const logic = notebookSelectButtonLogic({ ...props, visible })
    const { showPopover } = useValues(logic)
    const { setShowPopover } = useActions(logic)

    const onNotebookOpened: NotebookSelectProps['onNotebookOpened'] = (...args) => {
        setShowPopover(false)
        props.onNotebookOpened?.(...args)
    }

    return (
        <LemonDropdown
            overlay={
                <div className="max-w-160">
                    <NotebookSelectList {...props} onNotebookOpened={onNotebookOpened} />
                </div>
            }
            matchWidth={false}
            actionable
            visible={!!showPopover}
            onVisibilityChange={(visible) => setShowPopover(visible)}
            closeOnClickInside={false}
        >
            {children}
        </LemonDropdown>
    )
}

export function NotebookSelectButton({ children, onNotebookOpened, ...props }: NotebookSelectButtonProps): JSX.Element {
    // if nodeLogic is available then the button is on a resource that _is already and currently in a notebook_
    const nodeLogic = useNotebookNode()
    const logic = notebookSelectButtonLogic({ ...props, onNotebookOpened })
    const { showPopover, notebooksContainingResource } = useValues(logic)
    const { loadNotebooksContainingResource } = useActions(logic)

    useEffect(() => {
        if (!nodeLogic) {
            loadNotebooksContainingResource()
        }
        // oxlint-disable-next-line exhaustive-deps
    }, [nodeLogic])

    const button = (
        <LemonButton
            icon={
                <IconWithCount count={notebooksContainingResource.length ?? 0} showZero={false}>
                    <IconNotebook />
                </IconWithCount>
            }
            data-attr={nodeLogic ? 'notebooks-add-button-in-a-notebook' : 'notebooks-add-button'}
            sideIcon={null}
            {...props}
            active={showPopover}
            onClick={() => {
                props.onClick?.()
                if (nodeLogic) {
                    // If we are in a Notebook then we just call the callback directly
                    onNotebookOpened?.(nodeLogic.props.notebookLogic, nodeLogic)
                }
            }}
            tooltip="Add to notebook"
        >
            {children ?? 'Notebooks'}
        </LemonButton>
    )

    return nodeLogic ? button : <NotebookSelectPopover {...props}>{button}</NotebookSelectPopover>
}
