import { useContext } from 'react';
import { ErmisCallContext } from '../context/ErmisCallContext';

export const useCallContext = () => {
  const context = useContext(ErmisCallContext);
  if (context === undefined) {
    throw new Error('useCallContext must be used within an ErmisCallProvider');
  }
  return context;
};
