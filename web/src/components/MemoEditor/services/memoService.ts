import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { isEqual } from "lodash-es";
import { memoServiceClient } from "@/connect";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import { getAttachmentUrl } from "@/utils/attachment";
import type { EditorState } from "../state";
import { uploadService } from "./uploadService";

/**
 * Splits newly uploaded attachments into inline image markdown and remaining attachments.
 * Images are rendered as `![filename](url)` appended to the content.
 */
function extractInlineImages(newAttachments: Attachment[]): { imageMarkdown: string; nonImageAttachments: Attachment[] } {
  const imageAttachments: Attachment[] = [];
  const nonImageAttachments: Attachment[] = [];

  for (const attachment of newAttachments) {
    if (attachment.type.startsWith("image/")) {
      imageAttachments.push(attachment);
    } else {
      nonImageAttachments.push(attachment);
    }
  }

  const imageMarkdown = imageAttachments
    .map((a) => `![${a.filename}](${getAttachmentUrl(a)})`)
    .join("\n");

  return { imageMarkdown, nonImageAttachments };
}

/**
 * Converts attachments to reference format for API requests.
 * The backend only needs the attachment name to link it to a memo.
 */
function toAttachmentReferences(attachments: Attachment[]): Attachment[] {
  return attachments.map((a) => create(AttachmentSchema, { name: a.name }));
}

function buildUpdateMask(
  prevMemo: Memo,
  state: EditorState,
  allAttachments: typeof state.metadata.attachments,
): { mask: Set<string>; patch: Partial<Memo> } {
  const mask = new Set<string>();
  const patch: Partial<Memo> = {
    name: prevMemo.name,
    content: state.content,
  };

  if (!isEqual(state.content, prevMemo.content)) {
    mask.add("content");
    patch.content = state.content;
  }
  if (!isEqual(state.metadata.visibility, prevMemo.visibility)) {
    mask.add("visibility");
    patch.visibility = state.metadata.visibility;
  }
  if (!isEqual(allAttachments, prevMemo.attachments)) {
    mask.add("attachments");
    patch.attachments = toAttachmentReferences(allAttachments);
  }
  if (!isEqual(state.metadata.relations, prevMemo.relations)) {
    mask.add("relations");
    patch.relations = state.metadata.relations;
  }
  if (!isEqual(state.metadata.location, prevMemo.location)) {
    mask.add("location");
    patch.location = state.metadata.location;
  }

  // Auto-update timestamp if content changed
  if (["content", "attachments", "relations", "location"].some((key) => mask.has(key))) {
    mask.add("update_time");
  }

  // Handle custom timestamps
  if (state.timestamps.createTime) {
    const prevCreateTime = prevMemo.createTime ? timestampDate(prevMemo.createTime) : undefined;
    if (!isEqual(state.timestamps.createTime, prevCreateTime)) {
      mask.add("create_time");
      patch.createTime = timestampFromDate(state.timestamps.createTime);
    }
  }
  if (state.timestamps.updateTime) {
    const prevUpdateTime = prevMemo.updateTime ? timestampDate(prevMemo.updateTime) : undefined;
    if (!isEqual(state.timestamps.updateTime, prevUpdateTime)) {
      mask.add("update_time");
      patch.updateTime = timestampFromDate(state.timestamps.updateTime);
    }
  }

  return { mask, patch };
}

export const memoService = {
  async save(
    state: EditorState,
    options: {
      memoName?: string;
      parentMemoName?: string;
    },
  ): Promise<{ memoName: string; hasChanges: boolean }> {
    // 1. Upload local files first
    const newAttachments = await uploadService.uploadFiles(state.localFiles);
    const { imageMarkdown, nonImageAttachments } = extractInlineImages(newAttachments);
    const allAttachments = [...state.metadata.attachments, ...nonImageAttachments];
    const finalContent = imageMarkdown
      ? (state.content ? `${state.content}\n${imageMarkdown}` : imageMarkdown)
      : state.content;
    const effectiveState = imageMarkdown ? { ...state, content: finalContent } : state;

    // 2. Update existing memo
    if (options.memoName) {
      const prevMemo = await memoServiceClient.getMemo({ name: options.memoName });
      const { mask, patch } = buildUpdateMask(prevMemo, effectiveState, allAttachments);

      if (mask.size === 0) {
        return { memoName: prevMemo.name, hasChanges: false };
      }

      const memo = await memoServiceClient.updateMemo({
        memo: create(MemoSchema, patch as Record<string, unknown>),
        updateMask: create(FieldMaskSchema, { paths: Array.from(mask) }),
      });
      return { memoName: memo.name, hasChanges: true };
    }

    // 3. Create new memo or comment
    const memoData = create(MemoSchema, {
      content: finalContent,
      visibility: state.metadata.visibility,
      attachments: toAttachmentReferences(allAttachments),
      relations: state.metadata.relations,
      location: state.metadata.location,
      createTime: state.timestamps.createTime ? timestampFromDate(state.timestamps.createTime) : undefined,
      updateTime: state.timestamps.updateTime ? timestampFromDate(state.timestamps.updateTime) : undefined,
    });

    const memo = options.parentMemoName
      ? await memoServiceClient.createMemoComment({
          name: options.parentMemoName,
          comment: memoData,
        })
      : await memoServiceClient.createMemo({ memo: memoData });

    return { memoName: memo.name, hasChanges: true };
  },

  /**
   * Build the INIT_MEMO payload from an already-loaded Memo entity (no network
   * request). Returns only the fields the reducer's INIT_MEMO case consumes —
   * UI state (mode, loading flags, …) is owned by the reducer, not by memos.
   */
  fromMemo(memo: Memo): Pick<EditorState, "content" | "metadata" | "timestamps"> {
    return {
      content: memo.content,
      metadata: {
        visibility: memo.visibility,
        attachments: memo.attachments,
        relations: memo.relations,
        location: memo.location,
      },
      timestamps: {
        createTime: memo.createTime ? timestampDate(memo.createTime) : undefined,
        updateTime: memo.updateTime ? timestampDate(memo.updateTime) : undefined,
      },
    };
  },
};
