/**
 * StorageLine — a hairline strip above the home indicator on the root screen
 * only. One segment per downloaded model, sized against the whole disk.
 *
 * The gauge says the model is here; this says it weighs something. That pair is
 * the product argument, and no other AI app on the App Store shows either.
 *
 * It makes no claim it cannot support: if Device is unavailable there is no
 * disk total, and the whole strip hides rather than guessing.
 */
import React from 'react'
import { deviceWord } from './device.js'
import { GB } from './useLocalModels.js'

const fmt = (bytes) => {
  const gb = bytes / GB
  if (gb <= 0) return '0 GB'
  if (gb >= 10) return `${Math.round(gb)} GB`
  return `${gb.toFixed(1)} GB`
}

export default function StorageLine ({ downloaded = [], disk, usedBytes = 0, bytesOf }) {
  if (!disk || !disk.total) return null

  const size = (m) => (bytesOf ? bytesOf(m) : Math.round((Number(m?.sizeGB) || 0) * GB))
  const empty = downloaded.length === 0
  // free can come back null when Device answers with a total and nothing else;
  // the strip states what it knows and never invents the rest
  const free = typeof disk.free === 'number' ? disk.free : null

  return (
    <div className="rx-storage" style={{ position: 'fixed' }} data-empty={empty ? 'true' : undefined}>
      {/* ⚠️ NO RAIL IN THE ZERO STATE. A 4pt track with nothing in it, pinned
          above the home indicator, reads as a download stuck at 0% — in the one
          strip on the screen whose whole job is to be believed. The sentence
          carries the argument on its own until there is a segment to draw. */}
      {!empty && (
        <div className="rx-storage-track" aria-hidden="true">
          {downloaded.map(m => (
            <div
              key={m.id}
              className="rx-storage-seg"
              style={{ width: `${Math.max(0.6, (size(m) / disk.total) * 100)}%` }}
            />
          ))}
        </div>
      )}
      {/* One sentence in both states: a model is a thing that weighs something,
          and right now it weighs nothing. Naming the free space rather than
          "0 GB used" is the version that answers the question being asked. */}
      <div className="rx-storage-label">
        {empty
          ? (free === null
              ? `No models stored · ${fmt(disk.total)} on this ${deviceWord()}.`
              : `No models stored · ${fmt(free)} free of ${fmt(disk.total)}.`)
          : `${fmt(usedBytes)} of ${fmt(disk.total)} used by models.`}
      </div>
    </div>
  )
}

export { StorageLine }
