import React from 'react'

/**
 * Shimmer skeleton placeholder for the channel list loading state.
 * Uses TailwindCSS `animate-pulse` for the shimmer effect.
 * Renders 8 placeholder rows to fill the sidebar.
 */
const SkeletonRow = React.memo(() => (
  <div className="flex items-center gap-3 px-4 py-3">
    {/* Avatar skeleton */}
    <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-pulse shrink-0" />

    {/* Content skeleton */}
    <div className="flex-1 min-w-0 space-y-2">
      {/* Top row: name + timestamp */}
      <div className="flex items-center justify-between gap-3">
        <div className="h-3.5 w-28 rounded-md bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
        <div className="h-3 w-10 rounded-md bg-zinc-100 dark:bg-zinc-800/60 animate-pulse" />
      </div>
      {/* Bottom row: last message */}
      <div className="h-3 w-40 rounded-md bg-zinc-100 dark:bg-zinc-800/50 animate-pulse" />
    </div>
  </div>
))
SkeletonRow.displayName = 'SkeletonRow'

/** Variations for visual rhythm */
const SKELETON_WIDTHS = [
  { name: 'w-28', msg: 'w-40' },
  { name: 'w-32', msg: 'w-36' },
  { name: 'w-20', msg: 'w-44' },
  { name: 'w-36', msg: 'w-28' },
  { name: 'w-24', msg: 'w-48' },
  { name: 'w-30', msg: 'w-32' },
  { name: 'w-28', msg: 'w-40' },
  { name: 'w-20', msg: 'w-36' },
]

export const ChannelListSkeleton: React.FC<{ text?: string }> = React.memo(() => (
  <div className="flex flex-col py-1">
    {SKELETON_WIDTHS.map((widths, i) => (
      <div key={i} className="flex items-center gap-3 px-4 py-3" style={{ animationDelay: `${i * 60}ms` }}>
        {/* Avatar — alternate shapes for visual variety */}
        <div
          className={`w-10 h-10 shrink-0 bg-zinc-200 dark:bg-zinc-800 animate-pulse ${
            i % 3 === 0 ? 'rounded-[25%]' : 'rounded-full'
          }`}
        />

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div
              className={`h-3.5 rounded-md bg-zinc-200 dark:bg-zinc-800 animate-pulse ${widths.name}`}
              style={{ animationDelay: `${i * 80}ms` }}
            />
            <div
              className="h-3 w-10 rounded-md bg-zinc-100 dark:bg-zinc-800/60 animate-pulse"
              style={{ animationDelay: `${i * 100}ms` }}
            />
          </div>
          <div
            className={`h-3 rounded-md bg-zinc-100 dark:bg-zinc-800/50 animate-pulse ${widths.msg}`}
            style={{ animationDelay: `${i * 100 + 40}ms` }}
          />
        </div>
      </div>
    ))}
  </div>
))
ChannelListSkeleton.displayName = 'ChannelListSkeleton'
