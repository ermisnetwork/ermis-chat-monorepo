import React from 'react';

const MediaGridSkeleton = () => (
  <div className="grid grid-cols-3 gap-1 p-1">
    {[...Array(9)].map((_, i) => (
      <div 
        key={i} 
        className="aspect-square bg-zinc-100 dark:bg-zinc-800/50 animate-pulse rounded-sm"
        style={{ animationDelay: `${i * 100}ms` }}
      />
    ))}
  </div>
);

const ListSkeleton = () => (
  <div className="flex flex-col p-4 space-y-4">
    {[...Array(6)].map((_, i) => (
      <div key={i} className="flex items-center space-x-3 animate-pulse">
        <div className="w-10 h-10 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-zinc-100 dark:bg-zinc-800/50 rounded w-3/4" />
          <div className="h-2 bg-zinc-50 dark:bg-zinc-800/30 rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

const MemberListSkeleton = () => (
  <div className="flex flex-col p-4 space-y-4">
    {[...Array(5)].map((_, i) => (
      <div key={i} className="flex items-center space-x-3 animate-pulse">
        <div className="w-10 h-10 bg-zinc-100 dark:bg-zinc-800/50 rounded-full shrink-0" />
        <div className="h-4 bg-zinc-100 dark:bg-zinc-800/50 rounded w-1/3" />
      </div>
    ))}
  </div>
);

export const UhmTabLoadingState: React.FC<{ tab?: string }> = React.memo(({ tab }) => {
  switch (tab) {
    case 'media':
      return <MediaGridSkeleton />;
    case 'links':
    case 'files':
      return <ListSkeleton />;
    case 'members':
      return <MemberListSkeleton />;
    default:
      return (
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <div className="w-6 h-6 border-2 border-zinc-200 dark:border-zinc-800 border-t-indigo-500 rounded-full animate-spin" />
        </div>
      );
  }
});

UhmTabLoadingState.displayName = 'UhmTabLoadingState';
