// Phone photos are several megabytes. A note needs far less, and a smaller file finishes
// uploading sooner. Drawing a photo again also drops its metadata, such as the location
// where it was taken. JPEG, because Safari on iOS cannot encode WebP and silently returns
// a much larger PNG instead. Smaller pictures are kept unchanged.
const longestSide = 1600;

export const shrinkPhoto = async (photo: File) => {
  const bitmap = await createImageBitmap(photo);
  const scale = longestSide / Math.max(bitmap.width, bitmap.height);

  if (scale >= 1) {
    bitmap.close();

    return photo;
  }

  const canvas = document.createElement("canvas");

  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");

  if (!context) throw new Error("The browser cannot draw the photo");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.8),
  );

  if (!blob) throw new Error("The browser cannot encode the photo");

  return new File([blob], `${photo.name.replace(/\.[^.]*$/, "")}.jpg`, { type: blob.type });
};
