/**
 * Clio's candidate, versioned pollen morphology vocabulary.
 *
 * The vocabulary is an application profile rather than a claim of formal
 * conformance to GPP, TDWG, Plant Ontology, or any other standards body. It
 * keeps the stable codes Clio stores separate from display labels, and leaves
 * room for a contributor to supply a useful verbatim observation when a term
 * cannot (yet) be mapped.
 */

export const POLLEN_MORPHOLOGY_VOCABULARY_KEY = "clio.pollen-morphology" as const;
export const POLLEN_MORPHOLOGY_VOCABULARY_VERSION = "0.1.0" as const;
export const POLLEN_MORPHOLOGY_VOCABULARY_ID = "clio-pollen-morphology-0-1-0" as const;
export const POLLEN_MORPHOLOGY_VOCABULARY_COMMITMENT = "sha256:e673de8791ebd1496e5e3e49d4240451ab39e91e4c0aeb5e4d9b938da73ef15e" as const;

export type PollenObservationState = "observed" | "not_observed" | "not_applicable" | "indeterminate";
export type PollenAssertionKind = "controlled" | "numeric" | "verbatim_only";
export const POLLEN_MEASUREMENT_METHODS = ["LM", "SEM", "TEM", "other", "not_recorded"] as const;
export type PollenMeasurementMethod = (typeof POLLEN_MEASUREMENT_METHODS)[number];

export const POLLEN_MATERIAL_STATES = [
  "fresh_hydrated", "dry", "acetolysed", "rehydrated", "other", "not_recorded",
] as const;

export const POLLEN_DISPERSAL_UNITS = [
  "monad", "dyad", "tetrad", "polyad", "massula", "pollinium", "other",
] as const;
export type PollenDispersalUnit = (typeof POLLEN_DISPERSAL_UNITS)[number];

export const POLLEN_TETRAD_CONFIGURATIONS = [
  "linear", "rhomboidal", "tetragonal", "t_shaped", "decussate", "tetrahedral", "other",
] as const;
export type PollenTetradConfiguration = (typeof POLLEN_TETRAD_CONFIGURATIONS)[number];

export const POLLEN_POLARITY_TERMS = ["apolar", "isopolar", "heteropolar"] as const;
export const POLLEN_POLARITIES = [...POLLEN_POLARITY_TERMS, "indeterminate"] as const;
export type PollenPolarity = (typeof POLLEN_POLARITIES)[number];

export const POLLEN_SYMMETRY_TERMS = ["radial", "bilateral"] as const;
export const POLLEN_SYMMETRIES = [...POLLEN_SYMMETRY_TERMS, "indeterminate"] as const;
export type PollenSymmetry = (typeof POLLEN_SYMMETRIES)[number];

/** P/E classes, with open upper/lower bounds at the ends. */
export const POLLEN_SHAPE_CLASSES = [
  "peroblate", "oblate", "suboblate", "oblate-spheroidal", "prolate-spheroidal", "subprolate", "prolate", "perprolate", "other",
] as const;
export type PollenShapeClass = (typeof POLLEN_SHAPE_CLASSES)[number];

export const POLLEN_APERTURE_PRESENCE_TERMS = ["present", "inaperturate"] as const;
export const POLLEN_APERTURE_PRESENCE = [...POLLEN_APERTURE_PRESENCE_TERMS, "indeterminate"] as const;
export type PollenAperturePresence = (typeof POLLEN_APERTURE_PRESENCE)[number];

export const POLLEN_APERTURE_TYPES = [
  "colpus", "pore", "sulcus", "ulcus", "colporus", "other",
] as const;
export type PollenApertureType = (typeof POLLEN_APERTURE_TYPES)[number];

export const POLLEN_APERTURE_POSITIONS = [
  "proximal", "distal", "equatorial", "global", "other",
] as const;
export type PollenAperturePosition = (typeof POLLEN_APERTURE_POSITIONS)[number];

export const POLLEN_ORNAMENTATION_TERMS = [
  "psilate", "scabrate", "echinate", "granulate", "gemmate", "verrucate", "baculate", "clavate",
  "reticulate", "striate", "rugulate", "perforate", "foveolate", "other",
] as const;
export type PollenOrnamentation = (typeof POLLEN_ORNAMENTATION_TERMS)[number];

export const POLLEN_APERTURE_FEATURES = ["annulus", "margo", "costa", "operculum", "membrane", "other"] as const;
export const POLLEN_TECTUM_TERMS = ["eutectate", "semitectate", "atectate", "other"] as const;
export const POLLEN_INFRATECTUM_TERMS = ["alveolate", "columellate", "granular", "absent", "other"] as const;

export type PollenTraitKey =
  | "dispersal_unit"
  | "tetrad_configuration"
  | "polarity"
  | "symmetry"
  | "shape_class"
  | "polar_axis_length"
  | "equatorial_diameter"
  | "p_e_ratio"
  | "aperture_presence"
  | "aperture_count"
  | "aperture_type"
  | "aperture_position"
  | "aperture_feature"
  | "sculpture"
  | "tectum"
  | "infratectum";

export type PollenVocabularyTrait = Readonly<{
  key: PollenTraitKey;
  label: string;
  valueKind: "controlled" | "numeric";
  terms?: readonly string[];
  unitPolicy: "none" | "optional" | "required";
  observationStates: readonly PollenObservationState[];
  methods?: readonly PollenMeasurementMethod[];
}>;

const OBSERVATION_STATES: readonly PollenObservationState[] = ["observed", "not_observed", "not_applicable", "indeterminate"];

export const POLLEN_MORPHOLOGY_TRAITS: readonly PollenVocabularyTrait[] = Object.freeze([
  { key: "dispersal_unit", label: "Dispersal unit", valueKind: "controlled", terms: POLLEN_DISPERSAL_UNITS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "tetrad_configuration", label: "Tetrad configuration", valueKind: "controlled", terms: POLLEN_TETRAD_CONFIGURATIONS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "polarity", label: "Polarity", valueKind: "controlled", terms: POLLEN_POLARITY_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "symmetry", label: "Symmetry", valueKind: "controlled", terms: POLLEN_SYMMETRY_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "shape_class", label: "Shape class (P/E ratio)", valueKind: "controlled", terms: POLLEN_SHAPE_CLASSES, unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "polar_axis_length", label: "Polar axis length", valueKind: "numeric", unitPolicy: "optional", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "equatorial_diameter", label: "Equatorial diameter", valueKind: "numeric", unitPolicy: "optional", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "p_e_ratio", label: "Polar/equatorial ratio", valueKind: "numeric", unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "aperture_presence", label: "Aperture presence", valueKind: "controlled", terms: POLLEN_APERTURE_PRESENCE_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "aperture_count", label: "Aperture count", valueKind: "numeric", unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "aperture_type", label: "Aperture type", valueKind: "controlled", terms: POLLEN_APERTURE_TYPES, unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "aperture_position", label: "Aperture position", valueKind: "controlled", terms: POLLEN_APERTURE_POSITIONS, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "aperture_feature", label: "Aperture feature", valueKind: "controlled", terms: POLLEN_APERTURE_FEATURES, unitPolicy: "none", observationStates: OBSERVATION_STATES },
  { key: "sculpture", label: "Sculpture / ornamentation", valueKind: "controlled", terms: POLLEN_ORNAMENTATION_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "tectum", label: "Tectum", valueKind: "controlled", terms: POLLEN_TECTUM_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
  { key: "infratectum", label: "Infratectum", valueKind: "controlled", terms: POLLEN_INFRATECTUM_TERMS, unitPolicy: "none", observationStates: OBSERVATION_STATES, methods: POLLEN_MEASUREMENT_METHODS },
].map((trait) => Object.freeze({ ...trait, ...(trait.terms ? { terms: Object.freeze([...trait.terms]) } : {}), observationStates: Object.freeze([...trait.observationStates]), ...(trait.methods ? { methods: Object.freeze([...trait.methods]) } : {}) })) as readonly PollenVocabularyTrait[]);

export type PollenVocabularyCitation = Readonly<{
  label: string;
  doi: string;
  uri: string;
  licence?: string;
  note: string;
}>;

export const POLLEN_MORPHOLOGY_CITATIONS: readonly PollenVocabularyCitation[] = Object.freeze([
  {
    label: "Illustrated Pollen Terminology, 2nd edition",
    doi: "10.1007/978-3-319-71365-6",
    uri: "https://link.springer.com/book/10.1007/978-3-319-71365-6",
    licence: "CC BY 4.0",
    note: "Primary open reference for the application labels and glossary structure.",
  },
  {
    label: "Glossary of pollen and spore terminology",
    doi: "10.1016/j.revpalbo.2006.06.008",
    uri: "https://doi.org/10.1016/j.revpalbo.2006.06.008",
    note: "Widely used palynological reference terminology; cited as source context, not copied as a database glossary.",
  },
]);

export const POLLEN_MORPHOLOGY_VOCABULARY = Object.freeze({
  id: POLLEN_MORPHOLOGY_VOCABULARY_ID,
  key: POLLEN_MORPHOLOGY_VOCABULARY_KEY,
  version: POLLEN_MORPHOLOGY_VOCABULARY_VERSION,
  title: "Clio candidate pollen morphology vocabulary",
  status: "candidate",
  conformanceClaim: "none",
  sourceCitations: POLLEN_MORPHOLOGY_CITATIONS,
  traits: POLLEN_MORPHOLOGY_TRAITS,
});

/** Stable JSON used to bind the source registry to a stored copy. */
export function canonicalPollenMorphologyVocabularyDefinition(): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(POLLEN_MORPHOLOGY_VOCABULARY));
}

export type PollenShapeDerivation = Readonly<{
  polarAxis: number;
  equatorialDiameter: number;
  ratio: number;
  shapeClass: Exclude<PollenShapeClass, "other">;
  method: "P/E-ratio-v1";
}>;

/**
 * Derive the standard P/E shape class without discarding the source
 * measurements. Values must be positive finite measurements in the same unit.
 */
export function derivePollenShapeClass(polarAxis: number, equatorialDiameter: number): PollenShapeDerivation | undefined {
  if (!Number.isFinite(polarAxis) || !Number.isFinite(equatorialDiameter) || polarAxis <= 0 || equatorialDiameter <= 0) return undefined;
  const ratio = polarAxis / equatorialDiameter;
  const shapeClass: Exclude<PollenShapeClass, "other"> = ratio < 0.5 ? "peroblate"
    : ratio < 0.75 ? "oblate"
      : ratio < 0.88 ? "suboblate"
        : ratio < 1 ? "oblate-spheroidal"
          : ratio < 1.14 ? "prolate-spheroidal"
            : ratio < 1.33 ? "subprolate"
              : ratio <= 2 ? "prolate" : "perprolate";
  return { polarAxis, equatorialDiameter, ratio, shapeClass, method: "P/E-ratio-v1" };
}

export function isPollenTerm(trait: PollenTraitKey, value: string): boolean {
  const definition = POLLEN_MORPHOLOGY_TRAITS.find((candidate) => candidate.key === trait);
  return definition?.terms?.includes(value) ?? false;
}
