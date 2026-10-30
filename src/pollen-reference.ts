/** Structured, per-image pollen calibration metadata for exchange workflows. */
export const POLLEN_IMAGE_VIEWS = ["polar", "equatorial", "oblique", "other", "not_recorded"] as const;
export type PollenImageView = (typeof POLLEN_IMAGE_VIEWS)[number];

export interface PollenImageCalibration {
  readonly mediaObjectId?: string;
  readonly mediaOrdinal?: number;
  readonly micrometresPerPixel?: number;
  readonly calibrationDistancePixels?: number;
  readonly calibrationDistanceMicrometres?: number;
  readonly calibrationReference?: string;
  readonly focusStackFrameCount?: number;
  readonly focusStepMicrometres?: number;
  readonly imageView?: PollenImageView;
  readonly notes?: string;
}

const keys = new Set([
  "mediaObjectId", "mediaOrdinal", "micrometresPerPixel", "calibrationDistancePixels",
  "calibrationDistanceMicrometres", "calibrationReference", "focusStackFrameCount",
  "focusStepMicrometres", "imageView", "notes",
]);

const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const optionalPositive = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);

/** Validate the bounded JSON profile field before it reaches canonical data. */
export function isPollenImageCalibrations(value: unknown): value is readonly PollenImageCalibration[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  return value.every((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    if (Object.keys(item).some((key) => !keys.has(key))) return false;
    const hasReference = boundedString(item.mediaObjectId, 256)
      || (typeof item.mediaOrdinal === "number" && Number.isInteger(item.mediaOrdinal) && item.mediaOrdinal >= 0);
    const hasCalibrationEvidence = item.micrometresPerPixel !== undefined
      || item.calibrationDistancePixels !== undefined
      || item.calibrationDistanceMicrometres !== undefined
      || item.calibrationReference !== undefined
      || item.focusStackFrameCount !== undefined
      || item.focusStepMicrometres !== undefined
      || item.imageView !== undefined;
    return hasReference
      && hasCalibrationEvidence
      && (item.mediaObjectId === undefined || boundedString(item.mediaObjectId, 256))
      && (item.mediaOrdinal === undefined || (typeof item.mediaOrdinal === "number" && Number.isInteger(item.mediaOrdinal) && item.mediaOrdinal >= 0))
      && optionalPositive(item.micrometresPerPixel)
      && optionalPositive(item.calibrationDistancePixels)
      && optionalPositive(item.calibrationDistanceMicrometres)
      && (item.calibrationReference === undefined || boundedString(item.calibrationReference, 2_048))
      && (item.focusStackFrameCount === undefined || (typeof item.focusStackFrameCount === "number" && Number.isInteger(item.focusStackFrameCount) && item.focusStackFrameCount > 0))
      && optionalPositive(item.focusStepMicrometres)
      && (item.imageView === undefined || POLLEN_IMAGE_VIEWS.includes(item.imageView as PollenImageView))
      && (item.notes === undefined || boundedString(item.notes, 4_000));
  });
}
