export interface CameraOptions {
  width?: number;
  height?: number;
  fps?: number;
}

/** Ouvre la webcam et attend que la vidéo ait ses dimensions. */
export async function startCamera(
  video: HTMLVideoElement,
  { width = 1280, height = 720, fps = 60 }: CameraOptions = {},
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps },
    },
  });

  video.srcObject = stream;
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
  }
  await video.play();
  return stream;
}
