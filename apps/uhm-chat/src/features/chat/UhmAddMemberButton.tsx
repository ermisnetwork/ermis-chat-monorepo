import React from 'react';
import { UserPlus } from 'lucide-react';

export const UhmAddMemberButton: React.FC<{
  onClick: () => void;
  label?: string;
}> = ({ onClick, label = 'Add Member' }) => {
  return (
    <button 
      onClick={onClick}
      className="flex items-center justify-center gap-2 w-full px-3 py-2 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-800/50 dark:hover:bg-zinc-800 transition-colors duration-200 rounded-lg group border border-dashed border-zinc-200 dark:border-zinc-700/50"
    >
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-indigo-500 group-hover:scale-105 transition-transform duration-200">
        <UserPlus className="w-3.5 h-3.5" />
      </div>
      <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>
    </button>
  );
};

UhmAddMemberButton.displayName = 'UhmAddMemberButton';
