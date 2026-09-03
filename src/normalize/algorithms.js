// Curated hashing-algorithm map.
//
// The workbook has no algorithm column, yet J/TH is only comparable within one
// algorithm: a Kaspa miner at 150 J/TH is not "inefficient", it is a different
// machine. This map is manufacturer product knowledge, kept apart from the sheet
// data and labelled as such (`algorithmSource: 'curated'`), so a reader can tell a
// stated fact from an inferred one. Extend it when a new family enters the fleet.

export const Algorithm = Object.freeze({
  SHA256: 'SHA-256',        // Bitcoin: Antminer S/T series, WhatsMiner, SealMiner
  KHEAVYHASH: 'kHeavyHash', // Kaspa: Antminer KS series
  SCRYPT: 'Scrypt',         // Litecoin/Dogecoin: Antminer L7/L9, ElphaPex DG
  UNKNOWN: 'UNKNOWN',
});

const RULES = [
  [/\bks\d\b/i, Algorithm.KHEAVYHASH],
  [/\bl[79]\b|\bdg\d\b/i, Algorithm.SCRYPT],
  [/\b[st]\d{2}[a-z]?\+?/i, Algorithm.SHA256],
  [/whatsminer|sealminer/i, Algorithm.SHA256],
];

export function algorithmFor(label) {
  for (const [re, algo] of RULES) if (re.test(String(label))) return algo;
  return Algorithm.UNKNOWN;
}
