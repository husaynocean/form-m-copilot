/**
 * Downscale a photo in the browser before upload. Phone photos are often
 * 3–6 MB; Vercel functions accept at most 4.5 MB per request, and the model
 * reads documents fine at ~1800 px on the long side.
 */
export async function resizeImage(file: Blob, maxSide = 1800, quality = 0.85): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", quality));
  } catch {
    return file;
  }
}

export const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(b);
  });
