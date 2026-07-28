import { useEffect, useRef, useState } from "react";
import { dragContainsFiles } from "../composerDrag";

export function useGlobalFileDrop(config: { enabled: boolean; onFiles(files: File[]): void }): { dragActive: boolean } {
  const [dragActive, setDragActive] = useState(false);
  const depthRef = useRef(0);
  const enabledRef = useRef(config.enabled);
  const onFilesRef = useRef(config.onFiles);
  enabledRef.current = config.enabled;
  onFilesRef.current = config.onFiles;

  useEffect(() => {
    const clearDragState = () => {
      depthRef.current = 0;
      setDragActive(false);
    };
    const ownedByAnotherDropZone = (event: DragEvent) => event.target instanceof Element && Boolean(event.target.closest("[data-file-drop-owner]"));
    const enter = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) {
        clearDragState();
        return;
      }
      event.preventDefault();
      depthRef.current += 1;
      setDragActive(true);
    };
    const over = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      clearDragState();
      if (enabledRef.current && files.length > 0) onFilesRef.current(files);
    };
    const blur = () => clearDragState();

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (!config.enabled) setDragActive(false);
  }, [config.enabled]);

  return { dragActive };
}
