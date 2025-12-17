export type OptimizeImageOptions = {
  maxDimension: number;
  maxBytes: number;
  outputMimeType: "image/jpeg" | "image/webp";
  quality: number;
};

export type OptimizedImage = {
  dataUrl: string;
  width: number;
  height: number;
  mimeType: string;
  originalBytes: number;
  outputBytes: number;
  optimized: boolean;
};

const DEFAULT_OPTIONS: OptimizeImageOptions = {
  maxDimension: 2048,
  maxBytes: 6 * 1024 * 1024,
  outputMimeType: "image/jpeg",
  quality: 0.85,
};

function clampQuality(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_OPTIONS.quality;
  return Math.min(0.95, Math.max(0.3, value));
}

export function estimateBase64BytesFromDataUrl(dataUrl: string): number | null {
  const marker = "base64,";
  const index = dataUrl.indexOf(marker);
  if (index === -1) return null;

  const base64 = dataUrl.slice(index + marker.length).trim();
  if (!base64) return 0;

  const padding =
    base64.endsWith("==") ? 2
      : base64.endsWith("=") ? 1
        : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4 - padding));
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read blob as data URL"));
    };
    reader.readAsDataURL(blob);
  });
}

type DecodedDrawable = {
  width: number;
  height: number;
  draw: (
    ctx: CanvasRenderingContext2D,
    targetWidth: number,
    targetHeight: number
  ) => void;
  cleanup: () => void;
};

async function decodeImageBlob(blob: Blob): Promise<DecodedDrawable> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, targetWidth, targetHeight) => {
          ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        },
        cleanup: () => {
          bitmap.close();
        },
      };
    } catch {
      // Fall back to HTMLImageElement
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = objectUrl;
  });

  return {
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    draw: (ctx, targetWidth, targetHeight) => {
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    },
    cleanup: () => {
      URL.revokeObjectURL(objectUrl);
    },
  };
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode canvas"));
          return;
        }
        resolve(blob);
      },
      mimeType,
      clampQuality(quality)
    );
  });
}

export async function optimizeImageBlob(
  blob: Blob,
  options?: Partial<OptimizeImageOptions>
): Promise<OptimizedImage> {
  const merged: OptimizeImageOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    quality: clampQuality(options?.quality ?? DEFAULT_OPTIONS.quality),
  };

  const decoded = await decodeImageBlob(blob);
  const originalBytes = blob.size;

  const longestSide = Math.max(decoded.width, decoded.height);
  const initialScale =
    longestSide > merged.maxDimension ? merged.maxDimension / longestSide : 1;

  const needsResize = initialScale < 1;
  const needsReencode = originalBytes > merged.maxBytes;

  if (!needsResize && !needsReencode) {
    const originalDataUrl = await blobToDataUrl(blob);
    decoded.cleanup();
    return {
      dataUrl: originalDataUrl,
      width: decoded.width,
      height: decoded.height,
      mimeType: blob.type || "image/png",
      originalBytes,
      outputBytes: originalBytes,
      optimized: false,
    };
  }

  const maxAttempts = 6;
  let scale = initialScale;
  let quality = merged.quality;

  let lastBlob: Blob | null = null;
  let finalWidth = decoded.width;
  let finalHeight = decoded.height;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    finalWidth = Math.max(1, Math.round(decoded.width * scale));
    finalHeight = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = finalWidth;
    canvas.height = finalHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      decoded.cleanup();
      throw new Error("Canvas 2D context not available");
    }

    if (merged.outputMimeType === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, finalWidth, finalHeight);
    }

    decoded.draw(ctx, finalWidth, finalHeight);

    lastBlob = await canvasToBlob(canvas, merged.outputMimeType, quality);

    if (lastBlob.size <= merged.maxBytes) {
      break;
    }

    // Try reducing quality first, then reduce dimensions.
    if (quality > 0.65) {
      quality = Math.max(0.5, quality - 0.1);
      continue;
    }

    if (Math.max(finalWidth, finalHeight) <= 512) {
      break;
    }

    scale = scale * 0.85;
  }

  if (!lastBlob) {
    decoded.cleanup();
    throw new Error("Image optimization failed");
  }

  const optimizedDataUrl = await blobToDataUrl(lastBlob);
  decoded.cleanup();

  return {
    dataUrl: optimizedDataUrl,
    width: finalWidth,
    height: finalHeight,
    mimeType: lastBlob.type || merged.outputMimeType,
    originalBytes,
    outputBytes: lastBlob.size,
    optimized: true,
  };
}

export async function optimizeImageFile(
  file: File,
  options?: Partial<OptimizeImageOptions>
): Promise<OptimizedImage> {
  return await optimizeImageBlob(file, options);
}

export async function optimizeImageDataUrl(
  dataUrl: string,
  options?: Partial<OptimizeImageOptions>
): Promise<OptimizedImage> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return await optimizeImageBlob(blob, options);
}


