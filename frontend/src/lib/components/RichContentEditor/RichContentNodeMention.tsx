import { mergeAttributes, Node, NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import clsx from 'clsx'
import { LemonButton, ProfilePicture, Tooltip } from '@posthog/lemon-ui'
import { useValues } from 'kea'
import { membersLogic } from 'scenes/organization/membersLogic'
import { RichContentNodeType } from './types'

export interface RichContentNodeMentionAttrs {
    id?: number
}

const Component = (props: NodeViewProps): JSX.Element => {
    const { id } = props.node.attrs as RichContentNodeMentionAttrs

    const { meFirstMembers } = useValues(membersLogic)

    const member = meFirstMembers.find((member) => member.user.id === id)

    return (
        <NodeViewWrapper
            as="span"
            className={clsx('RichContentEditorMention', props.selected && 'RichContentEditorMention--selected')}
        >
            <Tooltip
                title={
                    <div className="p-2 flex items-center gap-2">
                        <ProfilePicture user={member?.user} size="xl" />
                        <div>
                            <div className="font-bold">{member?.user.first_name}</div>
                            <div className="text-sm">{member?.user.email}</div>
                        </div>
                    </div>
                }
            >
                <LemonButton size="small" noPadding type="secondary" sideIcon={null}>
                    <span className="p-1">@{member?.user.first_name ?? '(Member)'}</span>
                </LemonButton>
            </Tooltip>
        </NodeViewWrapper>
    )
}

export const RichContentNodeMention = Node.create({
    name: RichContentNodeType.Mention,
    inline: true,
    group: 'inline',
    atom: true,

    serializedText: (attrs: RichContentNodeMentionAttrs): string => {
        // mention is not a block so `getText` does not add a separator.
        // we need to add it manually
        return `(member:${attrs.id})`
    },

    addAttributes() {
        return {
            id: { default: null },
        }
    },

    parseHTML() {
        return [{ tag: RichContentNodeType.Mention }]
    },

    renderHTML({ HTMLAttributes }) {
        return [RichContentNodeType.Mention, mergeAttributes(HTMLAttributes)]
    },

    addNodeView() {
        return ReactNodeViewRenderer(Component)
    },
})
