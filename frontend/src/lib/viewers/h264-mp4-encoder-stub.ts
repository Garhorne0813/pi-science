/**
 * Mol* registers its optional MP4-export extension as part of the default
 * plugin graph. Pi-Science does not expose that extension, so keep the encoder
 * out of the browser bundle while retaining an explicit failure if it is ever
 * called accidentally.
 */
export async function createH264MP4Encoder(): Promise<never> {
  throw new Error("MP4 export is not enabled in Pi-Science");
}
