#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const sourceFile = path.join(workspaceRoot, 'website', 'hymn_script.js');

const outputRoot = path.join(projectRoot, 'public', 'data');
const lyricsRoot = path.join(outputRoot, 'lyrics');
const legacySearchIndexFile = path.join(outputRoot, 'search-index-fulltext.json');
const summaryFile = path.join(outputRoot, 'collections-summary.json');
const reportFile = path.join(outputRoot, 'data-validation-report.json');

const collectionDefs = [
  { key: 'hymn_a_data', collection: 'hymn_a', midiPrefix: 'p' },
  { key: 'hymn_b_data', collection: 'hymn_b', midiPrefix: 'w' },
  { key: 'hymn_c_data', collection: 'hymn_c', midiPrefix: '' },
];

const supplementalCollectionDefs = [
  { collection: 'hymn_d', fileName: 'hymn-d-full.json', source: 'json' },
  { collection: 'hymn_e', fileName: 'rig.txt', source: 'rig' },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readSource(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function loadCollections(sourceCode) {
  const sandbox = {};
  vm.runInNewContext(sourceCode, sandbox, { filename: 'hymn_script.js' });

  const out = {};
  for (const def of collectionDefs) {
    const data = sandbox[def.key];
    if (!data || typeof data !== 'object') {
      throw new Error(`Cannot find ${def.key} in source file.`);
    }
    out[def.collection] = { ...def, data };
  }
  return out;
}

function numericValueFromId(id) {
  const parts = id.split('_');
  const last = parts[parts.length - 1] || '';
  const parsed = Number.parseInt(last, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function computeRange(dataObj) {
  const numericIds = Object.keys(dataObj)
    .map(numericValueFromId)
    .filter((n) => n !== null);

  if (numericIds.length === 0) {
    return '000-000';
  }

  const min = Math.min(...numericIds);
  const max = Math.max(...numericIds);
  return `${pad3(min)}-${pad3(max)}`;
}

function computeRangeFromItems(items) {
  const numericIds = items
    .map((item) => {
      const numberValue = Number.parseInt(String(item?.number ?? '').trim(), 10);
      if (!Number.isNaN(numberValue)) return numberValue;
      return numericValueFromId(String(item?.id || ''));
    })
    .filter((n) => n !== null);

  if (numericIds.length === 0) {
    return '000-000';
  }

  const min = Math.min(...numericIds);
  const max = Math.max(...numericIds);
  return `${pad3(min)}-${pad3(max)}`;
}

function buildAudioPath(midiPrefix, number) {
  if (!midiPrefix) {
    return '';
  }
  return `midi/${midiPrefix}${number}.mp3`;
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function getCollectionFullFileName(collection) {
  if (collection === 'hymn_a') return 'hymn-a-full.json';
  if (collection === 'hymn_b') return 'hymn-b-full.json';
  if (collection === 'hymn_c') return 'hymn-c-full.json';
  if (collection === 'hymn_d') return 'hymn-d-full.json';
  if (collection === 'hymn_e') return 'hymn-e-full.json';
  return `${collection}-full.json`;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start].trim()) {
    start += 1;
  }

  while (end > start && !lines[end - 1].trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function categoryRangeForHymnE(number) {
  const value = Number.parseInt(String(number || '').trim(), 10);
  if (Number.isNaN(value)) return '';
  if (value >= 1 && value <= 51) return '001-051';
  if (value >= 52 && value <= 96) return '052-096';
  if (value >= 97 && value <= 118) return '097-118';
  if (value >= 119 && value <= 131) return '119-131';
  if (value >= 132 && value <= 144) return '132-144';
  return '';
}

function parseRigCollection(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Rig source file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sections = raw
    .split(/^\s*-{8,}\s*$/gm)
    .map((block) => block.trim())
    .filter(Boolean);

  const items = [];

  for (const section of sections) {
    const numberMatch = section.match(/(?:^|\n)編號：\s*([^\n]+)/);
    const titleMatch = section.match(/(?:^|\n)歌名：\s*([^\n]+)/);
    const lyricsMarkerIndex = section.indexOf('歌詞：');

    if (!numberMatch || !titleMatch || lyricsMarkerIndex < 0) {
      continue;
    }

    const numberRaw = String(numberMatch[1] || '').trim();
    const numberInt = Number.parseInt(numberRaw, 10);
    const number = Number.isNaN(numberInt) ? numberRaw : pad3(numberInt);
    const idSuffix = Number.isNaN(numberInt) ? numberRaw : String(numberInt);
    const title = String(titleMatch[1] || '').trim();

    const bodyRaw = section.slice(lyricsMarkerIndex + '歌詞：'.length);
    const bodyLines = trimBlankEdges(bodyRaw.split('\n').map((line) => line.trimEnd()));

    let sourceLine = '';
    let lyricLines = bodyLines;
    if (bodyLines.length > 0) {
      const firstLine = bodyLines[0].trim();
      if (/^詩集：/.test(firstLine)) {
        sourceLine = firstLine.replace(/^詩集：\s*/, '').trim();
        lyricLines = bodyLines.slice(1);
      }
    }

    lyricLines = trimBlankEdges(lyricLines);

    const htmlLines = [];
    if (sourceLine) {
      htmlLines.push(sourceLine, '');
    }
    htmlLines.push(...lyricLines);

    items.push({
      id: `hymn_e_${idSuffix}`,
      collection: 'hymn_e',
      number,
      title,
      lyricsHtml: htmlLines.join('<br>'),
      categoryRange: categoryRangeForHymnE(number),
      audioPath: '',
    });
  }

  items.sort((a, b) => {
    if (a.number !== b.number) {
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    }
    return String(a.id).localeCompare(String(b.id));
  });

  return items;
}

function mergeSupplementalCollectionItems(collection, items) {
  if (collection !== 'hymn_d') {
    return items;
  }

  const englishIndex = items.findIndex((item) => item?.id === 'hymn_d_162');
  const chineseIndex = items.findIndex((item) => item?.id === 'hymn_d_162_2');
  if (englishIndex === -1) {
    return items;
  }

  if (chineseIndex === -1) {
    return items.map((item) => {
      if (item?.id !== 'hymn_d_162') return item;

      return {
        ...item,
        lyricsHtml: String(item.lyricsHtml || '')
          .replace(/<br><br><br><br>-I just need to glorify You<br><br><br><br>/g, '<br><br><br><br>I just need to glorify You<br><br>')
          .replace(/<br><br><br><br>I just need to glorify You<br><br><br><br>/g, '<br><br><br><br>I just need to glorify You<br><br>'),
      };
    });
  }

  const english = items[englishIndex];
  const chinese = items[chineseIndex];
  const englishTitle = String(english.title || '').trim().replace(/^[-\s]+/, '');
  const englishSection = [englishTitle, String(english.lyricsHtml || '').trim()].filter(Boolean).join('<br><br>');
  const mergedLyricsHtml = [
    String(chinese.lyricsHtml || '').trim(),
    englishSection,
  ]
    .filter(Boolean)
    .join('<br><br><br><br>');

  const mergedItem = {
    ...english,
    number: String(chinese.number || english.number || '').trim(),
    title: String(chinese.title || english.title || '').trim(),
    lyricsHtml: mergedLyricsHtml,
    categoryRange: String(chinese.categoryRange || english.categoryRange || '').trim(),
    audioPath: String(chinese.audioPath || english.audioPath || '').trim(),
  };

  return items
    .filter((item) => item?.id !== 'hymn_d_162' && item?.id !== 'hymn_d_162_2')
    .concat(mergedItem);
}

function loadSupplementalCollections() {
  const out = [];

  for (const def of supplementalCollectionDefs) {
    let items = [];
    let filePath = '';

    if (def.source === 'json') {
      filePath = path.join(outputRoot, def.fileName);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      items = mergeSupplementalCollectionItems(
        def.collection,
        Array.isArray(payload?.items) ? payload.items : [],
      );
    } else if (def.source === 'rig') {
      filePath = path.join(projectRoot, def.fileName);
      items = parseRigCollection(filePath);
    }

    out.push({
      ...def,
      filePath,
      items,
    });
  }

  return out;
}

function main() {
  const sourceCode = readSource(sourceFile);
  const collections = loadCollections(sourceCode);
  const supplementalCollections = loadSupplementalCollections();

  ensureDir(outputRoot);
  fs.rmSync(lyricsRoot, { recursive: true, force: true });
  fs.rmSync(legacySearchIndexFile, { force: true });
  fs.rmSync(path.join(outputRoot, 'search-index-lite.json'), { force: true });

  const collectionFullItems = Object.fromEntries(
    [
      ...Object.keys(collections),
      ...supplementalCollections.map((entry) => entry.collection),
    ].map((collection) => [collection, []]),
  );
  const collectionSummary = {};
  const seenIds = new Set();
  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile,
    totalSongs: 0,
    collections: {},
    duplicateIds: [],
    malformedRows: [],
    malformedHtml: [],
    audioMissing: [],
    invalidEncoding: [],
  };

  for (const [collection, meta] of Object.entries(collections)) {
    const range = computeRange(meta.data);

    let collectionCount = 0;
    let missingAudioCount = 0;

    for (const [id, row] of Object.entries(meta.data)) {
      if (!Array.isArray(row) || row.length < 3) {
        report.malformedRows.push({ collection, id });
        continue;
      }

      if (seenIds.has(id)) {
        report.duplicateIds.push(id);
        continue;
      }
      seenIds.add(id);

      const title = String(row[0] ?? '').trim();
      const number = String(row[1] ?? '').trim();
      const lyricsHtml = String(row[2] ?? '');
      const audioPath = buildAudioPath(meta.midiPrefix, number);

      if ((lyricsHtml.match(/</g) || []).length !== (lyricsHtml.match(/>/g) || []).length) {
        report.malformedHtml.push({ collection, id });
      }

      if (lyricsHtml.includes('\uFFFD') || title.includes('\uFFFD')) {
        report.invalidEncoding.push({ collection, id });
      }

      if (audioPath) {
        const absAudioPath = path.join(projectRoot, 'public', audioPath);
        if (!fs.existsSync(absAudioPath)) {
          report.audioMissing.push({ collection, id, audioPath });
          missingAudioCount += 1;
        }
      }

      const lyricPayload = {
        id,
        collection,
        number,
        title,
        lyricsHtml,
        categoryRange: range,
        audioPath,
      };

      collectionFullItems[collection].push(lyricPayload);

      collectionCount += 1;
    }

    collectionSummary[collection] = {
      count: collectionCount,
      range,
      missingAudioCount,
    };

    report.collections[collection] = {
      count: collectionCount,
      range,
      missingAudioCount,
    };

    report.totalSongs += collectionCount;
  }

  for (const supplemental of supplementalCollections) {
    const { collection, items } = supplemental;
    const range = computeRangeFromItems(items);

    let collectionCount = 0;
    let missingAudioCount = 0;

    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object' || !rawItem.id) {
        report.malformedRows.push({ collection, id: rawItem?.id || '' });
        continue;
      }

      const id = String(rawItem.id);
      if (seenIds.has(id)) {
        report.duplicateIds.push(id);
        continue;
      }
      seenIds.add(id);

      const title = String(rawItem.title ?? '').trim();
      const number = String(rawItem.number ?? '').trim();
      const lyricsHtml = String(rawItem.lyricsHtml ?? '');
      const audioPath = String(rawItem.audioPath ?? '').trim();

      if ((lyricsHtml.match(/</g) || []).length !== (lyricsHtml.match(/>/g) || []).length) {
        report.malformedHtml.push({ collection, id });
      }

      if (lyricsHtml.includes('\uFFFD') || title.includes('\uFFFD')) {
        report.invalidEncoding.push({ collection, id });
      }

      if (audioPath) {
        const absAudioPath = path.join(projectRoot, 'public', audioPath);
        if (!fs.existsSync(absAudioPath)) {
          report.audioMissing.push({ collection, id, audioPath });
          missingAudioCount += 1;
        }
      }

      const lyricPayload = {
        id,
        collection,
        number,
        title,
        lyricsHtml,
        categoryRange: String(rawItem.categoryRange || range),
        audioPath,
      };

      collectionFullItems[collection].push(lyricPayload);

      collectionCount += 1;
    }

    collectionSummary[collection] = {
      count: collectionCount,
      range,
      missingAudioCount,
    };

    report.collections[collection] = {
      count: collectionCount,
      range,
      missingAudioCount,
    };

    report.totalSongs += collectionCount;
  }

  for (const [collection, items] of Object.entries(collectionFullItems)) {
    items.sort((a, b) => {
      if (a.number !== b.number) {
        return a.number.localeCompare(b.number, undefined, { numeric: true });
      }
      return a.id.localeCompare(b.id);
    });

    writeJson(path.join(outputRoot, getCollectionFullFileName(collection)), {
      generatedAt: new Date().toISOString(),
      totalSongs: items.length,
      collection,
      items,
    });
  }

  writeJson(summaryFile, {
    generatedAt: new Date().toISOString(),
    collections: collectionSummary,
  });

  writeJson(reportFile, report);

  console.log(`Generated ${report.totalSongs} songs.`);
  console.log(`Collection full files: ${Object.keys(collectionFullItems).map(getCollectionFullFileName).join(', ')}`);
  console.log(`Validation report: ${path.relative(projectRoot, reportFile)}`);
  console.log(`Audio missing entries: ${report.audioMissing.length}`);
}

main();
