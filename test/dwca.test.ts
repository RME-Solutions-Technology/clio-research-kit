import assert from "node:assert/strict";
import test from "node:test";
import { DCTERMS_NAMESPACE, DWC_TERMS_NAMESPACE } from "../src/darwin-core.ts";
import {
  DWCA_ROW_TYPES,
  DarwinCoreArchiveError,
  buildDarwinCoreArchive,
  dwcaCell,
  listDarwinCoreArchiveEntries,
  validateDarwinCoreEligibility,
  type DarwinCoreArchive,
  type DarwinCoreArchiveInput,
  type DarwinCoreArchiveRecord,
} from "../src/dwca.ts";
import { DEFAULT_LICENCE_URI } from "../src/licensing.ts";
import type { MeasurementRow } from "../src/measurement-rows.ts";
import { ResearchPackageError, buildResearchPackage, verifyResearchPackage, type ResearchPackageInput, type ResearchPackageRecord } from "../src/research-package.ts";
import { recordDocument, type RecordEventFields, type RecordFields } from "../src/record-fields.ts";

// All values are synthetic test data. Marker strings let a test prove a value never leaves.
const SECRET_LOCALITY = "SECRET-LOCALITY-MARKER near the synthetic creek";
const SECRET_LIFE_STAGE = "RESTRICTED-LIFESTAGE-MARKER";

// ---------------------------------------------------------------------------
// A small XML reader for our own output: elements, attributes, text and the
// five predefined entities. It rejects DOCTYPE, other entities and stray '&'.

type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string };

function parseXml(source: string): XmlNode {
  assert.ok(!/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(source), "no DOCTYPE, entity or CDATA");
  assert.ok(!/&(?!(?:lt|gt|amp|quot|apos);)/u.test(source), "only predefined entities");
  const decode = (value: string) => value.replace(/&(lt|gt|amp|quot|apos);/gu, (_, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" })[name]!);
  let index = 0;
  const declaration = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u.exec(source);
  assert.ok(declaration, "starts with an XML declaration");
  index = declaration[0].length;
  const skipSpace = () => { while (/\s/u.test(source[index] ?? "")) index += 1; };
  const element = (): XmlNode => {
    skipSpace();
    assert.equal(source[index], "<", `element expected at ${index}`);
    index += 1;
    const name = /^[A-Za-z_][\w:.-]*/u.exec(source.slice(index))?.[0];
    assert.ok(name, "element name");
    index += name.length;
    const attributes: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (source.startsWith("/>", index)) { index += 2; return { name, attributes, children: [], text: "" }; }
      if (source[index] === ">") { index += 1; break; }
      const attribute = /^([A-Za-z_][\w:.-]*)="([^"<]*)"/u.exec(source.slice(index));
      assert.ok(attribute, `attribute expected near ${source.slice(index, index + 40)}`);
      assert.ok(!Object.hasOwn(attributes, attribute[1]!), `duplicate attribute ${attribute[1]}`);
      attributes[attribute[1]!] = decode(attribute[2]!);
      index += attribute[0].length;
    }
    const children: XmlNode[] = [];
    let text = "";
    for (;;) {
      assert.ok(index < source.length, `unclosed <${name}>`);
      if (source.startsWith(`</${name}>`, index)) { index += name.length + 3; return { name, attributes, children, text: decode(text) }; }
      if (source.startsWith("</", index)) assert.fail(`mismatched close inside <${name}>`);
      if (source[index] === "<") { children.push(element()); continue; }
      text += source[index];
      index += 1;
    }
  };
  const root = element();
  skipSpace();
  assert.equal(index, source.length, "nothing after the root element");
  return root;
}

const kids = (node: XmlNode, name: string) => node.children.filter((child) => child.name === name);
const kid = (node: XmlNode, name: string): XmlNode => {
  const found = kids(node, name);
  assert.equal(found.length, 1, `exactly one <${name}> in <${node.name}>`);
  return found[0]!;
};

// ---------------------------------------------------------------------------
// Synthetic records

const baseEvent: RecordEventFields = {
  eventDate: "2026-09-14",
  locality: SECRET_LOCALITY,
  recordedBy: "Test Observer",
  method: "Synthetic visual search",
  context: "Seen twice.\nSecond line\twith a tab.",
  countryCode: "AU",
  decimalLatitude: -33.8,
  decimalLongitude: 151.2,
  geodeticDatum: "EPSG:4326",
  coordinateUncertaintyM: 50,
  locationVisibility: "public",
};

function fields(profileId: string, profileVersion: string, data: Record<string, unknown>, event: Partial<RecordEventFields> = {}, overrides: Partial<RecordFields> = {}): RecordFields {
  return {
    title: `Synthetic ${profileId} record`,
    profile: { profileId, profileVersion, readinessTarget: "referenceable", data },
    event: { ...baseEvent, ...event },
    uncertaintyStatement: "None known.",
    authors: [{ ordinal: 0, nameLiteral: "Test Observer" }],
    media: [],
    rights: { licenceUri: DEFAULT_LICENCE_URI },
    ...overrides,
  };
}

const bird = (data: Record<string, unknown> = {}, event: Partial<RecordEventFields> = {}) => fields("clio.profile.biological-occurrence", "1.0.0", {
  recordBasis: "HumanObservation",
  taxonomicRank: "species",
  taxonScientificName: "Exemplaria synthetica",
  taxonAuthorship: "Tester, 2026",
  taxonKingdom: "Animalia",
  taxonFamily: "Exemplariidae",
  taxonGenus: "Exemplaria",
  taxonSpecificEpithet: "synthetica",
  taxonNomenclaturalCode: "ICZN",
  sex: "female",
  lifeStage: { value: SECRET_LIFE_STAGE, visibility: "restricted" },
  behaviour: "foraging",
  sourceReference: "Synthetic field notebook 1",
  ...data,
}, event);

const slide = () => fields("clio.profile.pollen-reference-slide", "1.1.0", {
  recordBasis: "PreservedSpecimen",
  taxonomicRank: "genus",
  taxonScientificName: "Exemplaria",
  pollenTaxonName: "Exemplaria",
  slideIdentifier: "SLIDE-TEST-0001",
  originalTaxonVerbatim: "Exemplaria sp. (old label)",
  preparationMethod: "acetolysis",
}, { eventDate: "2026-01-01/2026-01-31", locationVisibility: "generalized", decimalLatitude: -34, decimalLongitude: 150 });

const survey = (data: Record<string, unknown> = {}) => fields("clio.profile.structured-survey", "1.0.0", {
  recordBasis: "HumanObservation",
  taxonomicRank: "species",
  taxonScientificName: "Exemplaria synthetica",
  surveyProtocol: "Synthetic ten-minute point count v1",
  samplingUnit: "point",
  samplingEffort: { value: 10, unit: "minute" },
  samplingArea: { value: 400, unit: "square_metre" },
  eventCount: 3,
  environment: "dry heath",
  ...data,
});

const core = () => fields("clio.profile.pollen-field-aerobiological-palaeo-sample", "1.0.0", {
  sampleType: "sediment",
  sampleIdentifier: "CORE-TEST-12",
  sampleCollectedOn: "2026-07-01",
  collectionMethod: "Synthetic corer",
  sampleDepth: { value: 120, unit: "centimetre" },
}, { eventDate: "2026-07-01", locationVisibility: "restricted", privateLocationObjectRef: "private:test-location", decimalLatitude: undefined, decimalLongitude: undefined, geodeticDatum: undefined, coordinateUncertaintyM: undefined });

const depth: MeasurementRow = {
  measurementId: "m1",
  typeIri: "http://vocab.nerc.ac.uk/collection/P01/current/ADEPZZ01/",
  typeLabel: "Depth",
  value: { number: 6.5 },
  unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/ULAA/",
  unitLabel: "metres",
  attachedTo: { kind: "event", id: "e1" },
};
const wingLength: MeasurementRow = {
  measurementId: "m2",
  typeIri: "https://example.org/terms/wingLength",
  typeLabel: "Wing length",
  value: { number: 82 },
  unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/UXMM/",
  unitLabel: "millimetres",
  remarks: "first\nsecond",
};

function input(records: readonly DarwinCoreArchiveRecord[], overrides: Partial<DarwinCoreArchiveInput> = {}): DarwinCoreArchiveInput {
  return {
    datasetId: "urn:clio:research-package:test-dwca-0001",
    title: "Synthetic Darwin Core test dataset",
    description: "Synthetic records for archive tests.\n\nSecond paragraph.",
    createdAt: "2026-10-22T01:00:00Z",
    creator: { individualName: { givenName: "Test", surName: "Team" }, orcid: "https://orcid.org/0000-0002-1825-0097" },
    contact: { organizationName: "Synthetic Test Lab", email: "contact@example.org" },
    records,
    ...overrides,
  };
}

const occurrenceInput = () => input([
  { recordId: "rec-b", versionId: "v2", fields: slide(), rightsHolder: "Slide Holder" },
  { recordId: "rec-a", versionId: "v1", fields: bird(), landingPage: "https://example.org/records/rec-a", measurements: [wingLength] },
], {
  media: [
    { recordId: "rec-a", mediaType: "image/jpeg", licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: "https://example.org/media/rec-a.jpg" },
    { recordId: "rec-a", mediaType: "image/png", licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer" },
  ],
});

type ParsedTable = { header: string[]; rows: Record<string, string>[]; raw: string[][] };

function table(archive: DarwinCoreArchive, path: string): ParsedTable {
  const file = archive.files.find((item) => item.path === path);
  assert.ok(file, `${path} exists`);
  assert.ok(file.text.endsWith("\n") && !file.text.includes("\r"), `${path} uses LF line ends`);
  const lines = file.text.slice(0, -1).split("\n");
  const header = lines[0]!.split("\t");
  const raw = lines.slice(1).map((line) => line.split("\t"));
  for (const cells of raw) assert.equal(cells.length, header.length, `${path} rows have one cell per header`);
  return { header, raw, rows: raw.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]!]))) };
}

function fileText(archive: DarwinCoreArchive, path: string): string {
  const file = archive.files.find((item) => item.path === path);
  assert.ok(file, `${path} exists`);
  return file.text;
}

function localName(term: string): string {
  return term.slice(Math.max(term.lastIndexOf("/"), term.lastIndexOf("#")) + 1);
}

// ---------------------------------------------------------------------------

test("meta.xml describes every table, and each column index matches its file's header", () => {
  const archive = buildDarwinCoreArchive(occurrenceInput());
  assert.equal(archive.core, "occurrence");
  assert.deepEqual(archive.files.map((file) => file.path), ["meta.xml", "eml.xml", "occurrence.txt", "extendedmeasurementorfact.txt", "multimedia.txt"]);

  const meta = parseXml(fileText(archive, "meta.xml"));
  assert.equal(meta.name, "archive");
  assert.equal(meta.attributes.xmlns, "http://rs.tdwg.org/dwc/text/");
  assert.equal(meta.attributes.metadata, "eml.xml");
  const sections = meta.children;
  assert.deepEqual(sections.map((section) => section.name), ["core", "extension", "extension"]);
  assert.deepEqual(sections.map((section) => section.attributes.rowType), [DWCA_ROW_TYPES.occurrence, DWCA_ROW_TYPES.measurementOrFact, DWCA_ROW_TYPES.multimedia]);
  for (const section of sections) {
    assert.equal(section.attributes.encoding, "UTF-8");
    assert.equal(section.attributes.fieldsTerminatedBy, "\\t");
    assert.equal(section.attributes.linesTerminatedBy, "\\n");
    assert.equal(section.attributes.fieldsEnclosedBy, "");
    assert.equal(section.attributes.ignoreHeaderLines, "1");
    const location = kid(kid(section, "files"), "location").text;
    const { header } = table(archive, location);
    const idElement = kid(section, section.name === "core" ? "id" : "coreid");
    assert.equal(idElement.attributes.index, "0");
    const indexes = new Set<number>([0]);
    for (const field of kids(section, "field")) {
      const index = Number(field.attributes.index);
      assert.ok(Number.isInteger(index) && index >= 0 && index < header.length, `${location} index ${index} is inside the header`);
      assert.equal(header[index], localName(field.attributes.term!), `${location} column ${index} is ${field.attributes.term}`);
      assert.ok(field.attributes.term!.startsWith(DWC_TERMS_NAMESPACE) || field.attributes.term!.startsWith(DCTERMS_NAMESPACE) || field.attributes.term!.startsWith("http://rs.iobis.org/obis/terms/"));
      assert.ok(!indexes.has(index) || index === 0, `${location} index ${index} is mapped once`);
      indexes.add(index);
    }
    assert.equal(indexes.size, header.length, `${location}: every column is the id or has a term`);
  }
  const coreFields = kids(sections[0]!, "field").map((field) => field.attributes.term);
  assert.ok(coreFields.includes(`${DWC_TERMS_NAMESPACE}occurrenceID`));
  assert.ok(coreFields.includes(`${DWC_TERMS_NAMESPACE}basisOfRecord`));
  assert.ok(coreFields.includes(`${DCTERMS_NAMESPACE}license`));
  assert.ok(coreFields.includes(`${DCTERMS_NAMESPACE}rightsHolder`));
});

test("an occurrence core carries basisOfRecord, stable occurrenceIDs, rights and verbatim fields", () => {
  const archive = buildDarwinCoreArchive(occurrenceInput());
  const { rows } = table(archive, "occurrence.txt");
  assert.deepEqual(rows.map((row) => row.occurrenceID), ["https://example.org/records/rec-a", "urn:clio:record:rec-b"]);
  const [birdRow, slideRow] = rows as [Record<string, string>, Record<string, string>];
  assert.equal(birdRow.basisOfRecord, "HumanObservation");
  assert.equal(slideRow.basisOfRecord, "PreservedSpecimen");
  assert.equal(birdRow.license, DEFAULT_LICENCE_URI);
  assert.equal(birdRow.rightsHolder, "Test Observer");
  assert.equal(slideRow.rightsHolder, "Slide Holder");
  assert.equal(birdRow.references, "https://example.org/records/rec-a");
  assert.equal(birdRow.scientificName, "Exemplaria synthetica");
  assert.equal(birdRow.scientificNameAuthorship, "Tester, 2026");
  assert.equal(birdRow.nomenclaturalCode, "ICZN");
  assert.equal(birdRow.identificationReferences, "Synthetic field notebook 1");
  assert.equal(birdRow.recordedBy, "Test Observer");
  assert.equal(birdRow.eventDate, "2026-09-14");
  assert.equal(birdRow.verbatimEventDate, "2026-09-14");
  assert.equal(birdRow.eventRemarks, "Seen twice. Second line with a tab.", "tabs and line breaks become spaces");
  assert.equal(birdRow.decimalLatitude, "-33.8");
  assert.equal(birdRow.geodeticDatum, "EPSG:4326");
  assert.equal(birdRow.coordinateUncertaintyInMeters, "50");
  assert.equal(slideRow.eventDate, "2026-01-01/2026-01-31");
  assert.equal(slideRow.verbatimEventDate, "2026-01-01/2026-01-31");
  assert.equal(slideRow.verbatimIdentification, "Exemplaria sp. (old label)");
  assert.equal(slideRow.catalogNumber, "SLIDE-TEST-0001");
  assert.equal(slideRow.preparations, "acetolysis");
  assert.equal(slideRow.dataGeneralizations, "Coordinates were generalised by the contributor before deposit.");

  const media = table(archive, "multimedia.txt").rows;
  assert.equal(media.length, 1, "media without a public URL is left out");
  assert.deepEqual(media[0], {
    id: "https://example.org/records/rec-a", type: "StillImage", format: "image/jpeg", identifier: "https://example.org/media/rec-a.jpg",
    references: "https://example.org/records/rec-a", license: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer",
  });
  assert.deepEqual(archive.findings.map((item) => item.code), ["media_skipped"]);
  assert.equal(dwcaCell("a\tb\r\nc\u0000d"), "a b c d");
});

test("sound recordings are exported as Sound rows of the Simple Multimedia extension, with their MIME type and own licence", () => {
  const sound = (mediaType: string, name: string, extra: Record<string, string> = {}) => ({
    recordId: "rec-a", mediaType, licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: `https://example.org/media/${name}`, ...extra,
  });
  const archive = buildDarwinCoreArchive(input([
    { recordId: "rec-a", versionId: "v1", fields: bird(), landingPage: "https://example.org/records/rec-a" },
  ], {
    media: [
      sound("audio/mp4", "a.m4a"), sound("audio/mpeg", "b.mp3"), sound("audio/wav", "c.wav", { licence: "https://creativecommons.org/publicdomain/zero/1.0/" }),
      sound("audio/flac", "d.flac"), sound("audio/ogg", "e.ogg", { title: "Dawn chorus" }),
      { recordId: "rec-a", mediaType: "image/jpeg", licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: "https://example.org/media/f.jpg" },
    ],
  }));
  const rows = table(archive, "multimedia.txt").rows;
  assert.deepEqual(rows.map((row) => [row.type, row.format, row.identifier.slice("https://example.org/media/".length)]), [
    ["Sound", "audio/mp4", "a.m4a"], ["Sound", "audio/mpeg", "b.mp3"], ["Sound", "audio/wav", "c.wav"],
    ["Sound", "audio/flac", "d.flac"], ["Sound", "audio/ogg", "e.ogg"], ["StillImage", "image/jpeg", "f.jpg"],
  ]);
  for (const row of rows) assert.equal(row.id, "https://example.org/records/rec-a");
  assert.equal(rows[2]!.license, "https://creativecommons.org/publicdomain/zero/1.0/", "each file carries its own licence");
  assert.equal(rows[0]!.license, DEFAULT_LICENCE_URI);
  assert.equal(rows[4]!.title, "Dawn chorus");
  assert.equal(rows.every((row) => row.rightsHolder === "Test Observer"), true);
  // Sound follows the same gates as images: no public URL, licence or rights holder, no row.
  const gated = buildDarwinCoreArchive(input([{ recordId: "rec-a", versionId: "v1", fields: bird() }], {
    media: [
      { recordId: "rec-a", mediaType: "audio/mpeg", licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer" },
      sound("audio/mpeg", "x.mp3", { licence: "not a uri" }),
      sound("audio/mpeg", "y.mp3", { rightsHolder: "" }),
    ],
  }));
  assert.equal(gated.files.some((file) => file.path === "multimedia.txt"), false);
  assert.deepEqual(gated.findings.map((item) => item.code), ["media_skipped", "media_skipped", "media_skipped"]);
});

test("structured surveys use an Event core with an Occurrence extension", () => {
  const archive = buildDarwinCoreArchive(input([
    { recordId: "survey-1", versionId: "v1", fields: survey(), measurements: [depth, wingLength] },
    { recordId: "core-1", versionId: "v1", fields: core(), measurements: [{ ...depth, measurementId: "m3", attachedTo: undefined }] },
  ]));
  assert.equal(archive.core, "event");
  assert.deepEqual(archive.files.map((file) => file.path), ["meta.xml", "eml.xml", "event.txt", "occurrence.txt", "extendedmeasurementorfact.txt"]);
  const meta = parseXml(fileText(archive, "meta.xml"));
  assert.deepEqual(meta.children.map((section) => [section.name, section.attributes.rowType, kid(kid(section, "files"), "location").text]), [
    ["core", DWCA_ROW_TYPES.event, "event.txt"],
    ["extension", DWCA_ROW_TYPES.occurrence, "occurrence.txt"],
    ["extension", DWCA_ROW_TYPES.measurementOrFact, "extendedmeasurementorfact.txt"],
  ]);

  const events = table(archive, "event.txt");
  assert.equal(events.header[0], "eventID");
  assert.deepEqual(events.rows.map((row) => row.eventID), ["urn:clio:record:core-1#event", "urn:clio:record:survey-1#event"]);
  const [coreEvent, surveyEvent] = events.rows as [Record<string, string>, Record<string, string>];
  assert.equal(surveyEvent.samplingProtocol, "Synthetic ten-minute point count v1");
  assert.equal(surveyEvent.samplingEffort, "10 minute");
  assert.equal(surveyEvent.sampleSizeValue, "400");
  assert.equal(surveyEvent.sampleSizeUnit, "square metre");
  assert.equal(surveyEvent.habitat, "dry heath");
  assert.equal(coreEvent.samplingProtocol, "Synthetic visual search");
  assert.equal(coreEvent.decimalLatitude, "", "a restricted location has no coordinates");
  assert.match(coreEvent.informationWithheld!, /coordinates withheld \(restricted location\)/u);

  const occurrences = table(archive, "occurrence.txt");
  assert.equal(occurrences.header[0], "eventID");
  assert.equal(occurrences.rows.length, 1, "the pollen field sample is an event without an occurrence");
  assert.equal(occurrences.rows[0]!.eventID, "urn:clio:record:survey-1#event");
  assert.equal(occurrences.rows[0]!.occurrenceID, "urn:clio:record:survey-1");
  assert.equal(occurrences.rows[0]!.basisOfRecord, "HumanObservation");
  assert.equal(occurrences.rows[0]!.individualCount, "3");
  assert.equal(occurrences.rows[0]!.scientificName, "Exemplaria synthetica");
  assert.ok(!("eventDate" in occurrences.rows[0]!), "event terms stay on the event row");

  const eml = parseXml(fileText(archive, "eml.xml"));
  assert.equal(kid(kid(kid(eml, "dataset"), "keywordSet"), "keyword").text, "Samplingevent");
});

test("eMoF rows come from measurement rows and link to the core and occurrence", () => {
  const survey1 = buildDarwinCoreArchive(input([{ recordId: "survey-1", versionId: "v1", fields: survey(), measurements: [depth, wingLength] }]));
  const emof = table(survey1, "extendedmeasurementorfact.txt");
  assert.equal(emof.header[0], "id");
  assert.deepEqual(emof.rows.map((row) => [row.id, row.occurrenceID, row.measurementID, row.measurementType, row.measurementValue, row.measurementUnit]), [
    ["urn:clio:record:survey-1#event", "", "urn:clio:record:survey-1#measurement-m1", "Depth", "6.5", "metres"],
    ["urn:clio:record:survey-1#event", "urn:clio:record:survey-1", "urn:clio:record:survey-1#measurement-m2", "Wing length", "82", "millimetres"],
  ]);
  assert.equal(emof.rows[1]!.measurementTypeID, "https://example.org/terms/wingLength");
  assert.equal(emof.rows[1]!.measurementUnitID, "http://vocab.nerc.ac.uk/collection/P06/current/UXMM/");
  assert.equal(emof.rows[1]!.measurementRemarks, "first second");
  const meta = parseXml(fileText(survey1, "meta.xml"));
  const terms = kids(meta.children.find((section) => section.attributes.rowType === DWCA_ROW_TYPES.measurementOrFact)!, "field").map((field) => field.attributes.term);
  assert.ok(terms.includes("http://rs.iobis.org/obis/terms/measurementTypeID"));
  assert.ok(terms.includes("http://rs.iobis.org/obis/terms/measurementUnitID"));
  assert.ok(terms.includes(`${DWC_TERMS_NAMESPACE}measurementValue`));

  const occurrence = buildDarwinCoreArchive(occurrenceInput());
  const rows = table(occurrence, "extendedmeasurementorfact.txt");
  assert.deepEqual(rows.rows.map((row) => row.id), ["https://example.org/records/rec-a"]);
  assert.ok(!rows.header.includes("occurrenceID"), "an occurrence core needs no separate occurrence link");
});

test("eml.xml carries the GBIF-required elements, the CC BY 4.0 licence and derived coverage", () => {
  const archive = buildDarwinCoreArchive(occurrenceInput());
  const eml = parseXml(fileText(archive, "eml.xml"));
  assert.equal(eml.name, "eml:eml");
  assert.equal(eml.attributes["xmlns:eml"], "eml://ecoinformatics.org/eml-2.1.1");
  assert.match(eml.attributes["xsi:schemaLocation"]!, /^eml:\/\/ecoinformatics\.org\/eml-2\.1\.1 http:\/\/rs\.gbif\.org\/schema\/eml-gbif-profile\//u);
  assert.equal(eml.attributes.packageId, "urn:clio:research-package:test-dwca-0001");
  const dataset = kid(eml, "dataset");
  assert.deepEqual(dataset.children.map((child) => child.name), [
    "alternateIdentifier", "title", "creator", "metadataProvider", "pubDate", "language", "abstract", "keywordSet", "intellectualRights", "coverage", "contact",
  ], "EML 2.1.1 element order");
  assert.equal(kid(dataset, "title").text, "Synthetic Darwin Core test dataset");
  assert.equal(kid(dataset, "pubDate").text, "2026-10-22");
  assert.equal(kid(dataset, "language").text, "eng");
  assert.deepEqual(kids(kid(dataset, "abstract"), "para").map((para) => para.text), ["Synthetic records for archive tests.", "Second paragraph."]);
  const creator = kid(dataset, "creator");
  assert.equal(kid(kid(creator, "individualName"), "surName").text, "Team");
  assert.equal(kid(creator, "userId").text, "0000-0002-1825-0097");
  assert.equal(kid(creator, "userId").attributes.directory, "https://orcid.org/");
  assert.equal(kid(kid(dataset, "metadataProvider"), "individualName").children.length, 2, "metadataProvider defaults to the creator");
  assert.equal(kid(kid(dataset, "contact"), "organizationName").text, "Synthetic Test Lab");
  assert.equal(kid(kid(dataset, "contact"), "electronicMailAddress").text, "contact@example.org");

  const ulink = kid(kid(kid(dataset, "intellectualRights"), "para"), "ulink");
  assert.equal(ulink.attributes.url, "http://creativecommons.org/licenses/by/4.0/legalcode");
  assert.equal(kid(ulink, "citetitle").text, "Creative Commons Attribution (CC-BY) 4.0 License");

  const coverage = kid(dataset, "coverage");
  const box = kid(kid(coverage, "geographicCoverage"), "boundingCoordinates");
  assert.deepEqual(["west", "east", "north", "south"].map((side) => kid(box, `${side}BoundingCoordinate`).text), ["150", "151.2", "-33.8", "-34"]);
  const range = kid(kid(coverage, "temporalCoverage"), "rangeOfDates");
  assert.equal(kid(kid(range, "beginDate"), "calendarDate").text, "2026-01-01");
  assert.equal(kid(kid(range, "endDate"), "calendarDate").text, "2026-09-14");
  assert.deepEqual(kids(kid(coverage, "taxonomicCoverage"), "taxonomicClassification").map((item) => [kids(item, "taxonRankName")[0]?.text, kid(item, "taxonRankValue").text]), [
    ["genus", "Exemplaria"], ["species", "Exemplaria synthetica"],
  ]);
  assert.equal(kid(kid(kid(eml, "additionalMetadata"), "metadata"), "gbif").children.find((child) => child.name === "dateStamp")?.text, "2026-10-22T01:00:00Z");

  const escaped = buildDarwinCoreArchive(input([{ recordId: "rec-a", versionId: "v1", fields: bird() }], { title: "Birds & <bees> \"quoted\"" }));
  assert.equal(kid(kid(parseXml(fileText(escaped, "eml.xml")), "dataset"), "title").text, "Birds & <bees> \"quoted\"");
});

test("sensitive and restricted fields are withheld and named in informationWithheld", () => {
  const archive = buildDarwinCoreArchive(input([
    { recordId: "rec-a", versionId: "v1", fields: bird({}, { locationVisibility: "restricted", privateLocationObjectRef: "private:test-location", decimalLatitude: undefined, decimalLongitude: undefined }) },
  ]));
  for (const file of archive.files) {
    assert.ok(!file.text.includes("SECRET-LOCALITY-MARKER"), `${file.path} has no locality text (the field is sensitive)`);
    assert.ok(!file.text.includes(SECRET_LIFE_STAGE), `${file.path} has no restricted life stage`);
    assert.ok(!file.text.includes("private:test-location"), `${file.path} has no private location reference`);
  }
  const { header, rows } = table(archive, "occurrence.txt");
  assert.ok(!header.includes("locality") && !header.includes("verbatimLocality") && !header.includes("lifeStage"));
  assert.ok(!header.includes("decimalLatitude"));
  assert.equal(rows[0]!.informationWithheld, "locality withheld (sensitive field) | coordinates withheld (restricted location) | lifeStage withheld (restricted field)");
  const eml = parseXml(fileText(archive, "eml.xml"));
  assert.equal(kids(kid(kid(eml, "dataset"), "coverage"), "geographicCoverage").length, 0, "no bounding box from withheld coordinates");

  const pollenSample = buildDarwinCoreArchive(input([{ recordId: "core-1", versionId: "v1", fields: core() }]));
  for (const file of pollenSample.files) assert.ok(!file.text.includes("120"), `${file.path} has no sensitive sample depth`);

  const restrictedName = validateDarwinCoreEligibility(input([{ recordId: "rec-a", versionId: "v1", fields: bird({ taxonScientificName: { value: "Exemplaria synthetica", visibility: "restricted" } }) }]));
  assert.equal(restrictedName.eligible, false);
  assert.ok(restrictedName.findings.some((item) => item.code === "missing_scientific_name"));
});

test("ineligible input fails closed with a list of problems, and validation reports without throwing", () => {
  const cases: [string, DarwinCoreArchiveInput, string][] = [
    ["wrong profile", input([{ recordId: "rec-a", versionId: "v1", fields: fields("clio.profile.general-observation", "1.0.0", {}) }]), "unsupported_profile"],
    ["mixed cores", input([{ recordId: "rec-a", versionId: "v1", fields: bird() }, { recordId: "survey-1", versionId: "v1", fields: survey() }]), "mixed_cores"],
    ["two versions of a record", input([{ recordId: "rec-a", versionId: "v1", fields: bird() }, { recordId: "rec-a", versionId: "v2", fields: bird() }]), "duplicate_occurrence_id"],
    ["missing scientific name at readiness", input([{ recordId: "rec-a", versionId: "v1", fields: bird({ taxonScientificName: undefined }) }]), "record_invalid"],
    ["research-ready fields missing", input([{ recordId: "rec-a", versionId: "v1", fields: bird() }], { readiness: "research_ready" }), "record_invalid"],
    ["unparseable event date", input([{ recordId: "rec-a", versionId: "v1", fields: bird({}, { eventDate: "spring 2026" }) }]), "record_invalid"],
    ["no rights holder", input([{ recordId: "rec-a", versionId: "v1", fields: fields("clio.profile.biological-occurrence", "1.0.0", { recordBasis: "HumanObservation", taxonomicRank: "species", taxonScientificName: "Exemplaria synthetica" }, {}, { authors: [{ ordinal: 0, givenName: "Test", familyName: "Observer" }] }) }]), "missing_rights_holder"],
    ["other licence", input([{ recordId: "rec-a", versionId: "v1", fields: { ...bird(), rights: { licenceUri: "https://creativecommons.org/licenses/by-nc/4.0/" } } }]), "record_invalid"],
    ["unsafe landing page", input([{ recordId: "rec-a", versionId: "v1", fields: bird(), landingPage: "http://example.org/records/rec-a" }]), "invalid_landing_page"],
    ["bad measurements", input([{ recordId: "rec-a", versionId: "v1", fields: bird(), measurements: [{ ...wingLength, unitIri: undefined }] }]), "invalid_measurements"],
    ["no records", input([]), "no_records"],
    ["bad metadata", input([{ recordId: "rec-a", versionId: "v1", fields: bird() }], { contact: { email: "not-an-email" } }), "invalid_metadata"],
  ];
  for (const [label, candidate, code] of cases) {
    const result = validateDarwinCoreEligibility(candidate);
    assert.equal(result.eligible, false, label);
    assert.ok(result.findings.some((item) => item.code === code && item.severity === "error"), `${label}: ${code} in ${JSON.stringify(result.findings)}`);
    assert.throws(() => buildDarwinCoreArchive(candidate), (error: unknown) => {
      assert.ok(error instanceof DarwinCoreArchiveError, label);
      assert.ok(error.problems.length > 0, label);
      return true;
    });
  }
  const ok = validateDarwinCoreEligibility(occurrenceInput());
  assert.equal(ok.eligible, true);
  assert.equal(ok.core, "occurrence");
  assert.deepEqual(ok.findings.map((item) => [item.code, item.severity]), [["media_skipped", "warning"]]);
  const otherLicence = { name: "Creative Commons Attribution-NonCommercial 4.0 International", shortName: "CC BY-NC 4.0", spdxIdentifier: "CC-BY-NC-4.0", uri: "https://creativecommons.org/licenses/by-nc/4.0/" };
  const nc = buildDarwinCoreArchive({ ...occurrenceInput(), licence: otherLicence, records: [{ recordId: "rec-a", versionId: "v1", fields: { ...bird(), rights: { licenceUri: otherLicence.uri } } }], media: [] });
  assert.match(fileText(nc, "eml.xml"), /licensed under <ulink url="https:\/\/creativecommons.org\/licenses\/by-nc\/4.0\/"><citetitle>Creative Commons Attribution-NonCommercial 4.0 International<\/citetitle>/u, "a licence option changes the EML statement");
  assert.throws(() => buildDarwinCoreArchive({ ...occurrenceInput(), licence: { ...otherLicence, uri: "http://insecure.example/licence" } }), DarwinCoreArchiveError);
});

test("output is deterministic regardless of input order", () => {
  const first = buildDarwinCoreArchive(occurrenceInput());
  const reversed = occurrenceInput();
  const second = buildDarwinCoreArchive({ ...reversed, records: [...reversed.records].reverse(), media: [...(reversed.media ?? [])].reverse() });
  assert.deepEqual(second.files, first.files);
  const entries = listDarwinCoreArchiveEntries(first);
  assert.deepEqual(entries.map((entry) => entry.name), first.files.map((file) => file.path));
  assert.equal(entries[0]!.name, "meta.xml");
  assert.equal(new TextDecoder().decode(entries[2]!.bytes), fileText(first, "occurrence.txt"));
});

// ---------------------------------------------------------------------------
// The research package with its optional dwca/ folder

function packageRecord(recordId: string, versionId: string, recordFields: RecordFields, extra: Partial<ResearchPackageRecord> = {}): ResearchPackageRecord {
  return {
    recordId,
    versionId,
    profileId: recordFields.profile.profileId,
    profileVersion: recordFields.profile.profileVersion,
    title: recordFields.title,
    eventDate: recordFields.event.eventDate,
    licence: recordFields.rights.licenceUri,
    canonical: recordDocument({
      recordId, versionId, canonicalUri: `https://example.org/records/${recordId}`, recordType: "observation", subjectScopes: ["biology"], fields: recordFields,
    }),
    ...extra,
  };
}

function packageInput(overrides: Partial<ResearchPackageInput> = {}): ResearchPackageInput {
  return {
    packageId: "pkg-dwca-0001",
    title: "Synthetic package with a Darwin Core Archive",
    createdAt: "2026-10-22T01:00:00Z",
    creator: { name: "Test Team", orcid: "https://orcid.org/0000-0002-1825-0097" },
    schemas: [],
    records: [
      packageRecord("rec-a", "v1", bird(), { measurements: [wingLength] }),
      packageRecord("rec-b", "v2", slide(), { rightsHolder: "Slide Holder" }),
    ],
    media: [{ recordId: "rec-a", objectKey: "objects/a", mediaType: "image/jpeg", bytes: 10, sha256: "b".repeat(64), licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: "https://example.org/media/rec-a.jpg" }],
    includeDarwinCoreArchive: true,
    ...overrides,
  };
}

test("the dwca/ folder sits inside the BagIt payload, is described and listed, and the package still verifies", async () => {
  const built = await buildResearchPackage(packageInput());
  const verification = await verifyResearchPackage(built.files);
  assert.deepEqual(verification, { valid: true, problems: [] });
  const paths = built.files.map((file) => file.path);
  for (const path of ["data/dwca/meta.xml", "data/dwca/eml.xml", "data/dwca/occurrence.txt", "data/dwca/extendedmeasurementorfact.txt", "data/dwca/multimedia.txt"]) {
    assert.ok(paths.includes(path), path);
  }
  const text = (path: string) => new TextDecoder().decode(built.files.find((file) => file.path === path)!.bytes);
  const manifest = text("manifest-sha256.txt");
  assert.match(manifest, /  data\/dwca\/meta\.xml$/mu);
  assert.match(manifest, /  data\/dwca\/occurrence\.txt$/mu);
  const occurrences = text("data/dwca/occurrence.txt").split("\n");
  assert.ok(occurrences[1]!.startsWith("https://example.org/records/rec-a\t"), "the canonical landing URI is the occurrenceID");

  const dataPackage = JSON.parse(text("data/datapackage.json")) as { resources: { name: string; path: string; format: string }[] };
  const dwcaResources = dataPackage.resources.filter((resource) => resource.path.startsWith("dwca/"));
  assert.deepEqual(dwcaResources.map((resource) => [resource.path, resource.format]), [
    ["dwca/meta.xml", "xml"], ["dwca/eml.xml", "xml"], ["dwca/occurrence.txt", "tsv"], ["dwca/extendedmeasurementorfact.txt", "tsv"], ["dwca/multimedia.txt", "tsv"],
  ]);
  assert.equal(new Set(dataPackage.resources.map((resource) => resource.name)).size, dataPackage.resources.length, "resource names are unique");

  const crate = JSON.parse(text("data/ro-crate-metadata.json")) as { "@graph": { "@id": string; "@type": string; hasPart?: { "@id": string }[] }[] };
  const root = crate["@graph"].find((entity) => entity["@id"] === "./")!;
  assert.ok(root.hasPart!.some((part) => part["@id"] === "dwca/"));
  const folder = crate["@graph"].find((entity) => entity["@id"] === "dwca/")!;
  assert.equal(folder["@type"], "Dataset");
  assert.equal(folder.hasPart!.length, 5);
  for (const part of folder.hasPart!) assert.ok(crate["@graph"].some((entity) => entity["@id"] === part["@id"] && entity["@type"] === "File"), part["@id"]);
  assert.match(text("data/README.txt"), /dwca\/ is an unzipped Darwin Core Archive \(Occurrence core\)/u);

  const again = await buildResearchPackage(packageInput());
  assert.equal(again.manifestSha256, built.manifestSha256, "deterministic with the archive included");

  const tampered = built.files.map((file) => (file.path === "data/dwca/occurrence.txt" ? { ...file, bytes: new TextEncoder().encode("changed\n") } : file));
  assert.ok((await verifyResearchPackage(tampered)).problems.includes("data/dwca/occurrence.txt does not match its SHA-256"));

  const without = await buildResearchPackage(packageInput({ includeDarwinCoreArchive: false }));
  assert.ok(!without.files.some((file) => file.path.startsWith("data/dwca/")));
});

test("a package asked for a Darwin Core Archive fails closed when a record is ineligible", async () => {
  await assert.rejects(buildResearchPackage(packageInput({
    records: [packageRecord("rec-a", "v1", fields("clio.profile.general-observation", "1.0.0", {}))],
  })), (error: unknown) => {
    assert.ok(error instanceof ResearchPackageError);
    assert.ok(error.problems.some((problem) => problem.startsWith("dwca: record rec-a/v1: profile clio.profile.general-observation")), JSON.stringify(error.problems));
    return true;
  });
  await assert.rejects(buildResearchPackage(packageInput({
    records: [{ ...packageRecord("rec-a", "v1", bird()), canonical: { title: "not a record document" } }],
  })), (error: unknown) => error instanceof ResearchPackageError && error.problems.some((problem) => problem.includes("canonical JSON is not this record's")));
});
