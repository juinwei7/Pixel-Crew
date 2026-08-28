import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ComposerDocument, ComposerImage } from "../composerFiles";
import { mergeComposerItems, type QueuedCommand } from "../composerQueue";
import { t } from "../i18n";

type ComposerSession = { images: ComposerImage[]; documents: ComposerDocument[]; queued: QueuedCommand[]; error: string | null };
type PersistedComposerExtras = Pick<ComposerSession, "images" | "documents" | "queued">;

const COMPOSER_DB_NAME = "pixel-crew-composer";
const COMPOSER_DB_STORE = "session-extras";

export function useComposerSessionExtras(config: { enabled: boolean; sessionKey: string }): {
  images: ComposerImage[]; setImages: Dispatch<SetStateAction<ComposerImage[]>>;
  documents: ComposerDocument[]; setDocuments: Dispatch<SetStateAction<ComposerDocument[]>>;
  queued: QueuedCommand[]; setQueued: Dispatch<SetStateAction<QueuedCommand[]>>;
  error: string | null; setError: Dispatch<SetStateAction<string | null>>;
  switchingSession: boolean;
  restoringExtras: boolean;
  extrasSaved: boolean;
  persistenceWarning: string | null;
  ownerRef: MutableRefObject<string>;
  updateCachedSession(owner: string, update: (session: ComposerSession) => ComposerSession): void;
} {
  const { enabled, sessionKey } = config;
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [documents, setDocuments] = useState<ComposerDocument[]>([]);
  const [queued, setQueued] = useState<QueuedCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restoringExtras, setRestoringExtras] = useState(false);
  const [extrasSaved, setExtrasSaved] = useState(true);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);

  const sessionCacheRef = useRef(new Map<string, ComposerSession>());
  const sessionOwnerRef = useRef(sessionKey);
  const hydratedExtrasRef = useRef(new Set<string>());
  const extrasSaveRevisionRef = useRef(0);

  const switchingSession = enabled && sessionOwnerRef.current !== sessionKey;

  function updateCachedSession(owner: string, update: (session: ComposerSession) => ComposerSession) {
    const current = sessionCacheRef.current.get(owner) ?? { images: [], documents: [], queued: [], error: null };
    sessionCacheRef.current.set(owner, update(current));
  }

  // Session-switch: swap images/documents/queued/error atomically so a fast
  // switch between two NPCs never bleeds one worker's draft state into another.
  useEffect(() => {
    if (!enabled) {
      sessionOwnerRef.current = sessionKey;
      setImages([]);
      setDocuments([]);
      setQueued([]);
      setError(null);
      return;
    }
    if (sessionOwnerRef.current === sessionKey) return;
    const previousOwner = sessionOwnerRef.current;
    sessionCacheRef.current.set(previousOwner, { images, documents, queued, error });
    if (hydratedExtrasRef.current.has(previousOwner)) {
      void saveComposerExtras(previousOwner, { images, documents, queued }).catch(() => setPersistenceWarning(t("上一個 NPC 的附件與待送訊息無法保存")));
    }
    const next = sessionCacheRef.current.get(sessionKey) ?? { images: [], documents: [], queued: [], error: null };
    sessionOwnerRef.current = sessionKey;
    setImages(next.images);
    setDocuments(next.documents);
    setQueued(next.queued);
    setError(next.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const owner = sessionKey;
    // Once an owner has been hydrated once in this page's lifetime, the
    // in-memory cache (kept current via the session-switch effect above and
    // the debounced autosave below) is authoritative. Re-merging a stale
    // IndexedDB read on every revisit can resurrect edits (e.g. a cancelled
    // queued command) made after that snapshot was written but before this
    // async load resolves.
    if (hydratedExtrasRef.current.has(owner)) return;
    setRestoringExtras(true);
    void loadComposerExtras(owner).then((saved) => {
      if (cancelled || sessionOwnerRef.current !== owner) return;
      if (saved) {
        setImages((current) => mergeComposerItems(saved.images, current));
        setDocuments((current) => mergeComposerItems(saved.documents, current));
        setQueued((current) => mergeComposerItems(saved.queued, current));
      }
      hydratedExtrasRef.current.add(owner);
      setExtrasSaved(true);
      setPersistenceWarning(null);
    }).catch(() => {
      if (!cancelled) setPersistenceWarning(t("附件與待送訊息無法從本機儲存空間復原"));
      hydratedExtrasRef.current.add(owner);
    }).finally(() => {
      if (!cancelled) setRestoringExtras(false);
    });
    return () => { cancelled = true; };
  }, [enabled, sessionKey]);

  useEffect(() => {
    if (!enabled || switchingSession) return;
    const owner = sessionOwnerRef.current;
    if (!hydratedExtrasRef.current.has(owner)) return;
    const revision = extrasSaveRevisionRef.current + 1;
    extrasSaveRevisionRef.current = revision;
    setExtrasSaved(false);
    const snapshot = { images, documents, queued };
    const timer = window.setTimeout(() => {
      void saveComposerExtras(owner, snapshot).then(() => {
        if (sessionOwnerRef.current === owner && extrasSaveRevisionRef.current === revision) {
          setExtrasSaved(true);
          setPersistenceWarning(null);
        }
      }).catch(() => {
        if (sessionOwnerRef.current === owner && extrasSaveRevisionRef.current === revision) setPersistenceWarning(t("附件與待送訊息無法保存，離開前請先送出"));
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [enabled, documents, images, queued, switchingSession]);

  useEffect(() => {
    if (!enabled) return;
    const hasUnsavedExtras = images.length > 0 || documents.length > 0 || queued.length > 0;
    if (!hasUnsavedExtras || extrasSaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [enabled, documents.length, extrasSaved, images.length, queued.length]);

  return {
    images, setImages,
    documents, setDocuments,
    queued, setQueued,
    error, setError,
    switchingSession,
    restoringExtras,
    extrasSaved,
    persistenceWarning,
    ownerRef: sessionOwnerRef,
    updateCachedSession,
  };
}

function openComposerDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COMPOSER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(COMPOSER_DB_STORE)) request.result.createObjectStore(COMPOSER_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("composer database unavailable"));
  });
}

async function loadComposerExtras(sessionKey: string): Promise<PersistedComposerExtras | null> {
  const database = await openComposerDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COMPOSER_DB_STORE, "readonly");
    const request = transaction.objectStore(COMPOSER_DB_STORE).get(sessionKey);
    request.onsuccess = () => {
      const value = request.result as Partial<PersistedComposerExtras> | undefined;
      resolve(value && Array.isArray(value.images) && Array.isArray(value.documents) && Array.isArray(value.queued)
        ? { images: value.images, documents: value.documents, queued: value.queued }
        : null);
    };
    request.onerror = () => reject(request.error ?? new Error("composer restore failed"));
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function saveComposerExtras(sessionKey: string, extras: PersistedComposerExtras): Promise<void> {
  const database = await openComposerDatabase();
  if (!database) return;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COMPOSER_DB_STORE, "readwrite");
    transaction.objectStore(COMPOSER_DB_STORE).put(extras, sessionKey);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("composer save failed")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("composer save aborted")); };
  });
}
