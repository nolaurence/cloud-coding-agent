import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileContents } from "@pierre/diffs";
import type { ProjectFileContent, ProjectFileWriteResult } from "@cca/protocol";
import { Editor } from "@pierre/diffs/editor";
import {
  EditorProvider,
  File,
  Virtualizer,
  type FileOptions,
} from "@pierre/diffs/react";
import { request } from "../../lib/client";
import { useApp } from "../../lib/store";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../lib/theme";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { FileAutosaver, type FileSaveState } from "./fileAutosaver";
import {
  clearFileDraft,
  flushFileDraft,
  getFileDraft,
  saveFileDraft,
} from "./fileDrafts";

export type { FileSaveState } from "./fileAutosaver";

const VIRTUALIZER_CONFIG = {
  overscrollSize: 600,
  intersectionObserverMargin: 1_200,
} as const;
export interface ProjectFileEditorHandle {
  discard: () => void;
}

interface ProjectFileEditorProps {
  projectId: string;
  threadId: string;
  draftOwner: string;
  editable: boolean;
  file: ProjectFileContent;
  wordWrap: boolean;
  saveRequest: number;
  onSaveStateChange: (state: FileSaveState) => void;
  onSaved: (result: ProjectFileWriteResult, content: string) => void;
}

function contentCacheKey(path: string, content: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${path}:${content.length}:${hash >>> 0}`;
}

function saveError(reason: unknown) {
  return reason instanceof Error ? reason.message : "文件保存失败";
}

export const ProjectFileEditor = forwardRef<ProjectFileEditorHandle, ProjectFileEditorProps>(
  function ProjectFileEditor({
    projectId,
    threadId,
    draftOwner,
    editable,
    file,
    wordWrap,
    saveRequest,
    onSaveStateChange,
    onSaved,
  }, ref) {
    const { resolvedTheme } = useTheme();
    const connected = useApp((state) => state.connected);
    const mountedRef = useRef(false);
    const initializedRef = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const stateCallbackRef = useRef(onSaveStateChange);
    const savedCallbackRef = useRef(onSaved);
    stateCallbackRef.current = onSaveStateChange;
    savedCallbackRef.current = onSaved;

    const [initialDraft] = useState(() => {
      if (!editable) return null;
      const draft = getFileDraft(draftOwner, projectId, file.path);
      if (draft?.content === file.content) {
        clearFileDraft(draftOwner, projectId, file.path);
        return null;
      }
      return draft;
    });
    const initialContent = initialDraft?.content ?? file.content;
    const expectedVersionRef = useRef(initialDraft?.baseVersion ?? file.version);

    const sourceFileRef = useRef<FileContents | null>(null);
    if (sourceFileRef.current === null) {
      sourceFileRef.current = {
        name: file.path,
        contents: initialContent,
        cacheKey: contentCacheKey(file.path, initialContent),
      };
    }

    const autosaverRef = useRef<FileAutosaver<ProjectFileWriteResult> | null>(null);
    if (autosaverRef.current === null) {
      autosaverRef.current = new FileAutosaver<ProjectFileWriteResult>({
        initialContent: file.content,
        persist: async (content) => {
          const activeDraft = getFileDraft(draftOwner, projectId, file.path);
          const expectedVersion = activeDraft?.content === content
            ? activeDraft.baseVersion
            : expectedVersionRef.current;
          expectedVersionRef.current = expectedVersion;
          if (!activeDraft || activeDraft.content === content) {
            saveFileDraft(draftOwner, projectId, file.path, {
              content,
              baseVersion: expectedVersion,
              updatedAt: Date.now(),
            });
          }
          try {
            return await request<ProjectFileWriteResult>({
              type: "project.file.write",
              threadId,
              projectId,
              path: file.path,
              content,
              expectedVersion,
            });
          } catch (reason) {
            try {
              const current = await request<ProjectFileContent>({
                type: "project.file.read",
                projectId,
                path: file.path,
              });
              if (current.content === content) {
                return {
                  path: current.path,
                  size: current.size,
                  modifiedAt: current.modifiedAt,
                  version: current.version,
                };
              }
            } catch {
              // Preserve the original write error; a read can fail for the same transient reason.
            }

            const currentDraft = getFileDraft(draftOwner, projectId, file.path);
            if (currentDraft?.content === content) {
              saveFileDraft(draftOwner, projectId, file.path, {
                ...currentDraft,
                error: saveError(reason),
                updatedAt: Date.now(),
              });
            }
            throw reason;
          }
        },
        onState: (state) => {
          if (mountedRef.current) stateCallbackRef.current(state);
        },
        onSaved: (result, savedContent) => {
          expectedVersionRef.current = result.version;
          const currentDraft = getFileDraft(draftOwner, projectId, file.path);
          if (currentDraft?.content === savedContent) {
            clearFileDraft(draftOwner, projectId, file.path);
          } else if (currentDraft) {
            saveFileDraft(draftOwner, projectId, file.path, {
              content: currentDraft.content,
              baseVersion: result.version,
              updatedAt: Date.now(),
            });
          }
          if (mountedRef.current) savedCallbackRef.current(result, savedContent);
        },
      });
    }
    const autosaver = autosaverRef.current;

    const editorRef = useRef<Editor<unknown> | null>(null);
    if (editorRef.current === null) {
      editorRef.current = new Editor<unknown>({
        onChange: (nextFile) => {
          if (!editable || !sourceFileRef.current) return;
          sourceFileRef.current.contents = nextFile.contents;
          sourceFileRef.current.cacheKey = contentCacheKey(file.path, nextFile.contents);
          autosaver.change(nextFile.contents);
          if (autosaver.dirty) {
            saveFileDraft(draftOwner, projectId, file.path, {
              content: nextFile.contents,
              baseVersion: expectedVersionRef.current,
              updatedAt: Date.now(),
            });
          } else {
            clearFileDraft(draftOwner, projectId, file.path);
          }
        },
      });
    }
    const editor = editorRef.current;

    useEffect(() => {
      mountedRef.current = true;
      autosaver.activate();
      if (!initializedRef.current) {
        initializedRef.current = true;
        if (initialDraft) autosaver.change(initialContent);
        else stateCallbackRef.current({ status: "saved" });
      } else {
        stateCallbackRef.current(autosaver.state);
      }
      return () => {
        mountedRef.current = false;
        flushFileDraft(draftOwner, projectId, file.path);
        void autosaver.dispose();
      };
    }, [autosaver, draftOwner, file.path, initialContent, initialDraft, projectId]);

    const saveRequestRef = useRef(saveRequest);
    useEffect(() => {
      if (saveRequestRef.current === saveRequest) return;
      saveRequestRef.current = saveRequest;
      if (editable) void autosaver.retry();
    }, [autosaver, editable, saveRequest]);

    useEffect(() => {
      if (!editable) return undefined;
      const handleSaveShortcut = (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
        const activeElement = document.activeElement;
        if (!activeElement || !containerRef.current?.contains(activeElement)) return;
        event.preventDefault();
        void autosaver.flush();
      };
      window.addEventListener("keydown", handleSaveShortcut, true);
      return () => window.removeEventListener("keydown", handleSaveShortcut, true);
    }, [autosaver, editable]);

    const wasConnectedRef = useRef(connected);
    useEffect(() => {
      const reconnected = connected && !wasConnectedRef.current;
      wasConnectedRef.current = connected;
      if (editable && reconnected && autosaver.dirty) void autosaver.retry();
    }, [autosaver, connected, editable]);

    useImperativeHandle(ref, () => ({
      discard: () => {
        autosaver.cancel();
        clearFileDraft(draftOwner, projectId, file.path);
        if (mountedRef.current) stateCallbackRef.current({ status: "saved" });
      },
    }), [autosaver, draftOwner, file.path, projectId]);

    const themeName = resolveDiffThemeName(resolvedTheme);
    const options = useMemo<FileOptions<unknown>>(() => ({
      disableFileHeader: true,
      overflow: wordWrap ? "wrap" : "scroll",
      theme: themeName,
      themeType: resolvedTheme,
    }), [resolvedTheme, themeName, wordWrap]);

    return (
      <DiffWorkerPoolProvider>
        <EditorProvider editor={editor}>
          <div
              ref={containerRef}
              className="flex h-full min-h-0 flex-1"
              data-file-editor={file.path}
              aria-readonly={!editable}
            >
              <Virtualizer
                className="workspace-file-editor min-h-0 flex-1 overflow-auto"
                config={VIRTUALIZER_CONFIG}
              >
                <File
                  file={sourceFileRef.current}
                  options={options}
                  className="min-h-full"
                  contentEditable={editable}
                />
              </Virtualizer>
          </div>
        </EditorProvider>
      </DiffWorkerPoolProvider>
    );
  },
);
