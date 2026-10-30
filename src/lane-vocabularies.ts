/**
 * Controlled terms used by the 1.1 lane profiles (biology, astronomy,
 * geology, water/eDNA, imaging and pollen).
 *
 * Each list is a pick-list. Where a published IRI exists and the lane
 * research brief cites it, the IRI is kept beside the stored value so an
 * exporter never has to guess. A list without IRIs is a candidate
 * vocabulary, not a standard. Nothing here claims conformance with the
 * schemes named.
 */

export type IriMap = Readonly<Record<string, string>>;

const frozen = <T extends Record<string, string>>(value: T): Readonly<T> => Object.freeze({ ...value });

// ---------------------------------------------------------------- biology

/** Darwin Core basisOfRecord classes, as published in the GBIF basis-of-record vocabulary. */
export const LANE_BASIS_OF_RECORD = [
  "HumanObservation", "MachineObservation", "MaterialSample", "PreservedSpecimen", "LivingSpecimen", "FossilSpecimen", "Occurrence",
] as const;
export const LANE_BASIS_OF_RECORD_IRIS: IriMap = frozen({
  HumanObservation: "http://rs.tdwg.org/dwc/dwctype/HumanObservation",
  MachineObservation: "http://rs.tdwg.org/dwc/dwctype/MachineObservation",
  MaterialSample: "http://rs.tdwg.org/dwc/dwctype/MaterialSample",
  PreservedSpecimen: "http://rs.tdwg.org/dwc/dwctype/PreservedSpecimen",
  LivingSpecimen: "http://rs.tdwg.org/dwc/dwctype/LivingSpecimen",
  FossilSpecimen: "http://rs.tdwg.org/dwc/dwctype/FossilSpecimen",
  Occurrence: "http://rs.tdwg.org/dwc/dwctype/Occurrence",
});

/**
 * Stored as the current Darwin Core default terms. GBIF's interpreter is
 * documented with present/absent, so exports use the mapping below until a
 * validator run confirms the newer terms are accepted.
 */
export const LANE_OCCURRENCE_STATUS = ["detected", "notDetected"] as const;
export const LANE_OCCURRENCE_STATUS_EXPORT: Readonly<Record<(typeof LANE_OCCURRENCE_STATUS)[number], "present" | "absent">> = Object.freeze({
  detected: "present",
  notDetected: "absent",
});

/** Darwin Core establishmentMeans controlled vocabulary (dwc.tdwg.org/em). */
export const LANE_ESTABLISHMENT_MEANS = [
  "native", "nativeReintroduced", "introduced", "introducedAssistedColonisation", "vagrant", "uncertain", "nativeEndemic",
] as const;
export const LANE_ESTABLISHMENT_MEANS_IRIS: IriMap = frozen({
  native: "http://rs.tdwg.org/dwcem/values/e001",
  nativeReintroduced: "http://rs.tdwg.org/dwcem/values/e002",
  introduced: "http://rs.tdwg.org/dwcem/values/e003",
  introducedAssistedColonisation: "http://rs.tdwg.org/dwcem/values/e004",
  vagrant: "http://rs.tdwg.org/dwcem/values/e005",
  uncertain: "http://rs.tdwg.org/dwcem/values/e006",
  nativeEndemic: "http://rs.tdwg.org/dwcem/values/e007",
});

/** Wild versus kept or planted, asked in plain words; maps to establishment and basis on export. */
export const LANE_WILD_STATUS = ["wild", "planted_or_cultivated", "captive_or_kept", "not_sure"] as const;

/** Sex terms; IRIs from the NERC S10 collection used by the GBIF Sex vocabulary. */
export const LANE_SEX = ["female", "male", "hermaphrodite", "mixed", "indeterminate", "not_recorded", "not_applicable"] as const;
export const LANE_SEX_IRIS: IriMap = frozen({
  female: "http://vocab.nerc.ac.uk/collection/S10/current/S102/",
  male: "http://vocab.nerc.ac.uk/collection/S10/current/S103/",
  indeterminate: "http://vocab.nerc.ac.uk/collection/S10/current/S105/",
  mixed: "http://vocab.nerc.ac.uk/collection/S10/current/S108/",
});

/** Life-stage concepts from the GBIF LifeStage vocabulary. GBIF publishes no IRIs for them. */
export const LANE_LIFE_STAGES = [
  "adult", "juvenile", "subadult", "larva", "pupa", "nymph", "imago", "egg", "embryo", "tadpole",
  "nestling", "fledgling", "chick", "seedling", "flowering", "fruiting", "other", "unknown",
] as const;

/** How the scientific name was checked, using the GBIF match classes in plain words. */
export const LANE_NAME_RESOLUTION = ["exact_match", "close_spelling_match", "higher_rank_match", "no_match_kept_as_typed"] as const;

/** Starter survey protocol names (candidate list; no Darwin Core vocabulary exists). */
export const LANE_SURVEY_PROTOCOLS = [
  "point_count", "transect", "quadrat", "area_search", "stationary_count", "travelling_count", "pitfall_trap",
  "light_trap", "net", "camera_trap", "acoustic_recorder", "incidental", "other",
] as const;

// ---------------------------------------------------------------- location

/** Horizontal datums seen on Australian labels and devices, with EPSG CRS IRIs. */
export const LANE_GEODETIC_DATUMS = ["WGS84", "GDA2020", "GDA94", "AGD84", "AGD66", "NAD83", "ETRS89", "unknown"] as const;
export const LANE_GEODETIC_DATUM_IRIS: IriMap = frozen({
  WGS84: "http://www.opengis.net/def/crs/EPSG/0/4326",
  GDA2020: "http://www.opengis.net/def/crs/EPSG/0/7844",
  GDA94: "http://www.opengis.net/def/crs/EPSG/0/4283",
  AGD84: "http://www.opengis.net/def/crs/EPSG/0/4203",
  AGD66: "http://www.opengis.net/def/crs/EPSG/0/4202",
  NAD83: "http://www.opengis.net/def/crs/EPSG/0/4269",
  ETRS89: "http://www.opengis.net/def/crs/EPSG/0/4258",
});

/** Location treatments, identical to the universal event envelope's locationVisibility states. */
export const LANE_LOCATION_VISIBILITY = ["public", "generalized", "restricted", "not_collected"] as const;

// ---------------------------------------------------------------- astronomy

export const LANE_TIME_SCALES = ["UTC", "TAI", "TT", "TDB", "GPS", "unknown"] as const;
export const LANE_TIME_SOURCES = ["gps", "network_time", "phone_network", "camera_clock", "manual_watch", "unknown"] as const;
export const LANE_PLATE_SOLVE_STATUS = ["not_attempted", "header_claims_wcs", "solved_by_contributor", "unknown"] as const;

/** AAVSO extended-format FILTER codes (O is "other or unavailable"). */
export const LANE_AAVSO_FILTERS = [
  "U", "B", "V", "R", "I", "J", "H", "K", "TG", "TB", "TR", "CV", "CR", "SU", "SG", "SR", "SI", "SZ", "MA", "MB", "MI", "ZS", "Y", "HA", "HAC", "O",
] as const;
export const LANE_AAVSO_OBSERVATION_TYPES = ["CCD", "DSLR", "PEP", "Visual"] as const;
export const LANE_AAVSO_MAGNITUDE_TYPES = ["STD", "DIF", "ABS"] as const;

export const LANE_METEOR_REPORT_KINDS = ["visual_meteor_count", "fireball_sighting", "video_clip"] as const;
export const LANE_METEOR_COUNT_METHODS = ["count", "plot"] as const;
export const LANE_FIREBALL_SOUND = ["none", "at_the_same_time", "delayed", "not_sure"] as const;
export const LANE_FIREBALL_BRIGHTNESS = [
  "like_brightest_stars", "like_venus", "brighter_than_venus", "like_half_moon", "like_full_moon", "brighter_than_full_moon", "not_sure",
] as const;

// ---------------------------------------------------------------- geology

/**
 * Beginner rock names mapped to CGI Simple Lithology (v2016.01) concepts.
 * The IRI pattern follows the published scheme
 * http://resource.geosciml.org/classifier/cgi/lithology; individual concept
 * IRIs are pattern-derived and must be confirmed against the scheme's SKOS
 * download before any export relies on them.
 */
export const LANE_CGI_LITHOLOGY_SCHEME = "http://resource.geosciml.org/classifier/cgi/lithology";
const CGI_LITHOLOGY_TERMS = [
  "igneous_rock", "sedimentary_rock", "metamorphic_rock",
  "granite", "granodiorite", "diorite", "gabbro", "peridotite", "pegmatite", "basalt", "andesite", "dacite", "rhyolite",
  "sandstone", "siltstone", "mudstone", "claystone", "conglomerate", "breccia", "limestone", "chalk", "chert", "coal",
  "marble", "quartzite", "slate", "phyllite", "schist", "gneiss", "hornfels", "amphibolite", "serpentinite",
] as const;
export const LANE_LITHOLOGY_TERMS = [...CGI_LITHOLOGY_TERMS, "other", "unknown"] as const;
export const LANE_LITHOLOGY_IRIS: IriMap = Object.freeze(Object.fromEntries(CGI_LITHOLOGY_TERMS.map((term) => [term, `${LANE_CGI_LITHOLOGY_SCHEME}/${term}`])));

/**
 * International Chronostratigraphic Chart units with the ARDC/GeoSciML
 * "ischart" concept base. Names are the ICS names; confirm that no newer
 * chart edition supersedes the 2020 vocabulary before export.
 */
export const LANE_ICS_CHART_BASE = "http://resource.geosciml.org/classifier/ics/ischart";
const ICS_UNITS = [
  "Hadean", "Archean", "Proterozoic", "Phanerozoic",
  "Paleozoic", "Mesozoic", "Cenozoic",
  "Cambrian", "Ordovician", "Silurian", "Devonian", "Carboniferous", "Permian", "Triassic", "Jurassic", "Cretaceous", "Paleogene", "Neogene", "Quaternary",
  "Paleocene", "Eocene", "Oligocene", "Miocene", "Pliocene", "Pleistocene", "Holocene",
] as const;
export const LANE_GEOLOGIC_AGE_UNITS = [...ICS_UNITS, "unknown"] as const;
export const LANE_GEOLOGIC_AGE_IRIS: IriMap = Object.freeze(Object.fromEntries(ICS_UNITS.map((unit) => [unit, `${LANE_ICS_CHART_BASE}/${unit}`])));

export const LANE_AGE_BASIS = ["index_fossil", "radiometric_date", "geological_map_unit", "published_source", "estimate", "unknown"] as const;

/** Mindat-style IMA status categories, plus a beginner "not identified yet". */
export const LANE_IMA_STATUS = [
  "approved", "grandfathered", "discredited", "rejected", "questionable", "hypothetical", "intermediate_member", "variety_or_trade_name", "unidentified",
] as const;

export const LANE_SAMPLE_OBJECT_TYPES = [
  "hand_specimen", "loose_crystal", "fragment", "slab", "thin_section", "polished_section", "core", "powder", "loose_sediment", "fossil_specimen", "other", "unknown",
] as const;

/** Candidate collection-method list from the geology brief (no CGI or SESAR hard vocabulary exists). */
export const LANE_GEOLOGY_COLLECTION_METHODS = [
  "hand_collected_surface", "hand_dug", "float_loose", "outcrop_hammer", "mine_dump", "stream_gravel_panned", "core_or_drill",
  "photographed_not_collected", "purchased_or_gifted", "inherited", "unknown",
] as const;

export const LANE_LAND_TENURE = [
  "private_land", "crown_or_public_land", "national_park_or_reserve", "state_forest", "mining_lease", "aboriginal_land", "unknown",
] as const;
export const LANE_COLLECTION_AUTHORITY = [
  "landholder_consent", "fossicking_licence_or_miners_right", "public_fossicking_area", "permit", "purchased", "inherited",
  "existing_collection", "collected_before_rules_known", "none", "unknown",
] as const;
export const LANE_GEOLOGY_IDENTIFICATION_BASIS = [
  "seller_or_label", "matched_photos", "physical_tests", "specialist_opinion", "instrumental_analysis", "best_guess",
] as const;
export const LANE_PHOTO_SCALE = ["scale_bar_or_ruler", "known_size_object", "calibrated_image", "no_scale"] as const;
export const LANE_LUSTRE = ["metallic", "submetallic", "vitreous", "adamantine", "resinous", "pearly", "silky", "greasy", "dull", "not_recorded"] as const;
export const LANE_MAGNETISM = ["strong", "weak", "none", "not_tested"] as const;
export const LANE_ACID_REACTION = ["strong_fizz", "weak_fizz", "no_reaction", "not_tested"] as const;
export const LANE_HERITAGE_CHECK = ["no_signs_seen", "possible_cultural_material", "not_assessed"] as const;
export const LANE_METEORITE_CHECK = ["not_suspected", "possible_meteorite", "not_assessed"] as const;

// ---------------------------------------------------------------- water and eDNA

export const LANE_WATER_BODY_TYPES = ["river_or_creek", "lake_or_dam", "estuary", "ocean_or_coast", "other"] as const;

/** ENVO pick-list suggestions per water type (EBI OLS4 lookups cited in the water/eDNA brief). */
export const LANE_WATER_ENVO_DEFAULTS: Readonly<Record<Exclude<(typeof LANE_WATER_BODY_TYPES)[number], "other">, Readonly<{ envBroadScale: string; envMedium: string }>>> = Object.freeze({
  river_or_creek: Object.freeze({ envBroadScale: "http://purl.obolibrary.org/obo/ENVO_01000253", envMedium: "http://purl.obolibrary.org/obo/ENVO_01000599" }),
  lake_or_dam: Object.freeze({ envBroadScale: "http://purl.obolibrary.org/obo/ENVO_01000252", envMedium: "http://purl.obolibrary.org/obo/ENVO_04000007" }),
  estuary: Object.freeze({ envBroadScale: "http://purl.obolibrary.org/obo/ENVO_01000020", envMedium: "http://purl.obolibrary.org/obo/ENVO_01000301" }),
  ocean_or_coast: Object.freeze({ envBroadScale: "http://purl.obolibrary.org/obo/ENVO_00000447", envMedium: "http://purl.obolibrary.org/obo/ENVO_00002149" }),
});

/** Suggest ENVO context IRIs for a beginner water-type choice. Suggestions only; the contributor confirms. */
export function suggestedWaterEnvoContext(waterBodyType: string): Readonly<{ envBroadScale: string; envMedium: string }> | undefined {
  return (LANE_WATER_ENVO_DEFAULTS as Readonly<Record<string, Readonly<{ envBroadScale: string; envMedium: string }>>>)[waterBodyType];
}

export const LANE_ENVO_IRI_PATTERN = "^http://purl\\.obolibrary\\.org/obo/ENVO_[0-9]{8}$";

/** MIxS sample taxon (metagenome) choices with NCBI Taxonomy IRIs. */
export const LANE_SAMPLE_TAXA = ["freshwater_metagenome", "aquatic_metagenome", "marine_metagenome", "seawater_metagenome", "other"] as const;
export const LANE_SAMPLE_TAXON_IRIS: IriMap = frozen({
  freshwater_metagenome: "http://purl.obolibrary.org/obo/NCBITaxon_449393",
  aquatic_metagenome: "http://purl.obolibrary.org/obo/NCBITaxon_1169740",
  marine_metagenome: "http://purl.obolibrary.org/obo/NCBITaxon_408172",
  seawater_metagenome: "http://purl.obolibrary.org/obo/NCBITaxon_1561972",
});

/** FAIRe/MIxS sample category. */
export const LANE_SAMPLE_CATEGORIES = ["sample", "negative_control", "positive_control", "pcr_standard"] as const;

/** MIxS NegContTypeEnum, stored in snake case; export strings below. */
export const LANE_NEGATIVE_CONTROL_TYPES = [
  "dna_free_pcr_mix", "distilled_water", "empty_collection_device", "empty_collection_tube", "phosphate_buffer", "sterile_swab", "sterile_syringe",
] as const;
export const LANE_NEGATIVE_CONTROL_EXPORT: Readonly<Record<(typeof LANE_NEGATIVE_CONTROL_TYPES)[number], string>> = Object.freeze({
  dna_free_pcr_mix: "DNA-free PCR mix",
  distilled_water: "distilled water",
  empty_collection_device: "empty collection device",
  empty_collection_tube: "empty collection tube",
  phosphate_buffer: "phosphate buffer",
  sterile_swab: "sterile swab",
  sterile_syringe: "sterile syringe",
});

export const LANE_TARGET_GENES = ["12S_rRNA", "16S_rRNA", "18S_rRNA", "23S_rRNA", "COI", "ITS", "rbcL", "matK", "trnL", "other"] as const;
export const LANE_COLLECTION_DEVICES = ["syringe", "pump", "bottle", "bag", "scoop", "kit_with_inline_filter", "other"] as const;
export const LANE_PRESERVATIVES = [
  "kit_storage_buffer", "lysis_buffer", "longmires_solution", "ethanol", "frozen_without_preservative", "chilled_without_preservative", "other", "not_recorded",
] as const;

/** The read-layout states accepted by mixs_sequence_links.read_layout. */
export const LANE_READ_LAYOUTS = ["single", "paired", "other"] as const;

export const LANE_INSDC_BIOSAMPLE_PATTERN = "^SAM[EDN][A-Z]?[0-9]+$";
export const LANE_INSDC_ACCESSION_PATTERN = "^(?:PRJ[EDN][A-Z][0-9]+|SAM[EDN][A-Z]?[0-9]+|[EDS]R[APRSXZ][0-9]{6,})$";

// ---------------------------------------------------------------- imaging and pollen

export const LANE_IMAGING_METHODS = [
  "brightfield", "darkfield", "phase_contrast", "differential_interference_contrast", "polarised_light", "widefield_fluorescence",
  "confocal", "scanning_electron", "transmission_electron", "stereo_or_dissecting", "other",
] as const;
export const LANE_OBJECTIVE_IMMERSION = ["air", "oil", "water", "water_dipping", "glycerol", "silicone_oil", "other", "not_recorded"] as const;
export const LANE_SCALE_EVIDENCE = ["stage_micrometer_image", "scale_bar_in_image", "file_metadata", "no_scale"] as const;
export const LANE_CALIBRATION_METHODS = [
  "stage_micrometer", "scale_bar_two_point", "calibrated_software_metadata", "camera_pixel_pitch_and_optics", "nominal_from_magnification", "none",
] as const;
export const LANE_MICROSCOPY_SPECIMEN_KINDS = ["biological", "mineral_or_rock", "other_material"] as const;
export const LANE_POLLEN_MOUNTANTS = ["glycerol", "glycerol_jelly", "silicone_oil", "other", "not_recorded"] as const;
export const LANE_DEPTH_DATUMS = ["sediment_surface", "ground_surface", "water_surface", "core_top", "other"] as const;
export const LANE_AGE_TYPES = ["radiocarbon_years_bp", "calibrated_years_bp", "calendar_year_ad_bc", "other", "not_recorded"] as const;

/** Local spelling to UDUNITS/OME-NGFF spelling, used only when projecting or exporting. */
export const LANE_UDUNITS_LENGTH: Readonly<Record<string, string>> = Object.freeze({
  nanometre: "nanometer",
  micrometre: "micrometer",
  millimetre: "millimeter",
  metre: "meter",
});
