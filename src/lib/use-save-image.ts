import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useMutation } from 'convex/react';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { useCallback } from 'react';

export type LocalImage = {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
  /** Marks a subject-lifted die-cut PNG so the feed renders it as a sticker. */
  isSticker?: boolean;
  /** Original camera-roll capture time (epoch ms), read from EXIF on import. */
  capturedAt?: number;
  /** Where the photo was taken (signed decimal degrees), read from EXIF or
   * the media library on import. Set both or neither. */
  latitude?: number;
  longitude?: number;
};

/** One image plus its stable operation id. The id is a client-generated UUID
 * (optionally prefixed) that travels with the image across retries so a
 * re-submission reuses the same server operation instead of creating a new
 * item. `LocalImage` stays a description of the file; mutable status lives in
 * the operation ledger on the backend. */
export type ImageSaveRequest = {
  image: LocalImage;
  /** Reused on retry; auto-generated when absent (first attempt). */
  operationId?: string;
};

export type ImageSaveStage = 'begin' | 'upload' | 'attach' | 'finalize';

/** A settled per-image outcome. A failure is data, not a rejected promise, so
 * one image failing can never erase its siblings' success information. A caller
 * retries only `failed` results, passing their existing operationId back. */
export type ImageSaveResult =
  | {
      status: 'saved';
      operationId: string;
      image: LocalImage;
      itemId: Id<'items'>;
    }
  | {
      status: 'failed';
      operationId: string;
      image: LocalImage;
      stage: ImageSaveStage;
      message: string;
    };

/** The four backend ops the orchestration drives. Kept as a dependency object
 * so the orchestration is unit-testable with fakes and so `useSaveImages` can
 * bind it to the Convex `useMutation` hooks. */
export type SaveImageDeps = {
  begin: (operationId: string) => Promise<
    | { kind: 'upload'; uploadUrl: string }
    | { kind: 'complete'; itemId: Id<'items'> }
  >;
  upload: (image: LocalImage, uploadUrl: string) => Promise<Id<'_storage'>>;
  attach: (
    operationId: string,
    storageId: Id<'_storage'>,
  ) => Promise<{ storageId: Id<'_storage'> }>;
  finalize: (input: {
    operationId: string;
    aspectRatio?: number;
    isSticker?: boolean;
    capturedAt?: number;
    latitude?: number;
    longitude?: number;
    spaceId?: Id<'spaces'>;
  }) => Promise<Id<'items'>>;
};

/** Prefix lets operation ids stand out in server logs while keeping the UUID
 * as the stable, unique portion. */
function generateOperationId(): string {
  return `image:${Crypto.randomUUID()}`;
}

/** Maps an unknown thrown value to a short, user-safe message. Never surfaces
 * upload URLs, storage ids, or backend stack traces to the UI. */
function sanitizeMessage(error: unknown, stage: ImageSaveStage): string {
  if (error instanceof Error && error.message) {
    // Strip anything that looks like a URL or id leaked through a thrown
    // error. Real Convex ids are long unbroken lowercase-alphanumeric tokens
    // (~32 chars, no separators), which no natural-language word reaches.
    const cleaned = error.message
      .replace(/https?:\/\/\S+/gi, '<url>')
      .replace(/\b[a-z0-9]{25,}\b/g, '<id>')
      .slice(0, 200);
    return cleaned || `Could not complete (${stage})`;
  }
  return `Could not complete (${stage})`;
}

/**
 * Drives the begin -> upload -> attach -> finalize lifecycle for each image
 * concurrently and returns one settled result per input, in input order. Each
 * task catches its own errors (Promise.all never rejects here), so a failure is
 * reported as data rather than discarding sibling successes. A request without
 * an operationId gets a fresh one; a retry must pass the failed result's id.
 */
export async function saveImageOperations(
  requests: ImageSaveRequest[],
  deps: SaveImageDeps,
  options?: { spaceId?: Id<'spaces'> },
): Promise<ImageSaveResult[]> {
  return await Promise.all(
    requests.map(async (request): Promise<ImageSaveResult> => {
      const image = request.image;
      let stage: ImageSaveStage = 'begin';
      // Minted inside the try: if id generation itself throws, that image must
      // settle as a failed result like any other error — a rejection here would
      // reject the whole Promise.all and erase sibling successes.
      let operationId = request.operationId;
      try {
        // `||` (not `??`): the empty-string placeholder from a mint failure
        // must also get a fresh id on retry.
        operationId = operationId || generateOperationId();
        const began = await deps.begin(operationId);
        if (began.kind === 'complete') {
          // Already finalized server-side (a previous attempt landed); skip the
          // upload entirely and report the existing item.
          return { status: 'saved', operationId, image, itemId: began.itemId };
        }

        stage = 'upload';
        const uploadedStorageId = await deps.upload(image, began.uploadUrl);

        stage = 'attach';
        // Attach records the uploaded storage id on the pending operation (and,
        // for a racing retry that already attached a different id, discards this
        // redundant upload server-side). finalize reads the canonical id back
        // from the ledger, so we don't need the return value here.
        await deps.attach(operationId, uploadedStorageId);

        stage = 'finalize';
        const aspectRatio =
          image.width && image.height ? image.width / image.height : undefined;
        const itemId = await deps.finalize({
          operationId,
          aspectRatio,
          isSticker: image.isSticker,
          capturedAt: image.capturedAt,
          latitude: image.latitude,
          longitude: image.longitude,
          spaceId: options?.spaceId,
        });
        return { status: 'saved', operationId, image, itemId };
      } catch (error) {
        return {
          status: 'failed',
          // Only undefined if minting itself threw; the placeholder keeps the
          // result shape intact and a retry of it simply mints a fresh id.
          operationId: operationId ?? '',
          image,
          stage,
          message: sanitizeMessage(error, stage),
        };
      }
    }),
  );
}

/**
 * React/Convex adapter that binds saveImageOperations to the image import
 * mutations. Returns one result per input image, in input order; a single
 * image failure no longer rejects the whole batch.
 */
export function useSaveImages() {
  const beginImageImport = useMutation(api.items.beginImageImport);
  const attachImageUpload = useMutation(api.items.attachImageUpload);
  const finalizeImageImport = useMutation(api.items.finalizeImageImport);

  return useCallback(
    async (
      requests: ImageSaveRequest[],
      options?: { spaceId?: Id<'spaces'> },
    ): Promise<ImageSaveResult[]> => {
      const deps: SaveImageDeps = {
        begin: (operationId) => beginImageImport({ operationId }),
        upload: async (image, uploadUrl) => {
          const file = new File(image.uri);
          const result = await expoFetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': image.mimeType ?? 'image/jpeg' },
            body: file,
          });
          if (!result.ok) {
            throw new Error(`Upload failed (${result.status})`);
          }
          const { storageId } = (await result.json()) as {
            storageId: Id<'_storage'>;
          };
          return storageId;
        },
        attach: (operationId, storageId) =>
          attachImageUpload({ operationId, storageId }),
        finalize: (input) => finalizeImageImport(input),
      };
      return await saveImageOperations(requests, deps, options);
    },
    [beginImageImport, attachImageUpload, finalizeImageImport],
  );
}
