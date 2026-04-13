import React, { useState } from 'react';
import { LS_USER_ID_KEY, LS_USER_TOKEN_KEY, LS_API_KEY, LS_PROJECT_ID, LS_BASE_URL } from './constants';

export function CustomLoginStep({ onConnect, onBack, apiKey, projectId, baseUrl }: any) {
  const [userId, setUserId] = useState(() => localStorage.getItem(LS_USER_ID_KEY) ?? '');
  const [userToken, setUserToken] = useState(() => localStorage.getItem(LS_USER_TOKEN_KEY) ?? '');
  const [externalAuth, setExternalAuth] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCustomLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !userToken.trim()) {
      setError('Please provide User ID and Token.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      await onConnect(userId.trim(), userToken.trim(), externalAuth, apiKey.trim(), projectId.trim(), baseUrl.trim());
      
      localStorage.setItem(LS_USER_ID_KEY, userId.trim());
      localStorage.setItem(LS_USER_TOKEN_KEY, userToken.trim());
      localStorage.setItem(LS_API_KEY, apiKey.trim());
      localStorage.setItem(LS_PROJECT_ID, projectId.trim());
      localStorage.setItem(LS_BASE_URL, baseUrl.trim());
    } catch (err: any) {
      let errorMessage = 'Failed to connect. Please check your credentials.';
      try {
        const parsed = JSON.parse(err.message);
        if (parsed.message) errorMessage = parsed.message;
      } catch (e) {
        errorMessage = err?.message || errorMessage;
      }
      setError(errorMessage);
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleCustomLogin}>
      {error && <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>}
      <div className="mb-5">
        <label htmlFor="userId" className="block text-sm font-medium text-gray-300 mb-2">User ID</label>
        <input id="userId" type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="0x..." className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
      </div>
      <div className="mb-5">
        <label htmlFor="userToken" className="block text-sm font-medium text-gray-300 mb-2">User Token</label>
        <textarea id="userToken" value={userToken} onChange={(e) => setUserToken(e.target.value)} placeholder="eyJ..." rows={3} className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
      </div>
      <div className="mb-6 flex items-center justify-between">
        <label htmlFor="externalAuth" className="text-sm font-medium text-gray-300 cursor-pointer">Use External Auth</label>
        <button type="button" id="externalAuth" role="switch" aria-checked={externalAuth} onClick={() => setExternalAuth(!externalAuth)} className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${externalAuth ? 'bg-indigo-500' : 'bg-gray-700'}`}>
          <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${externalAuth ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>
      <div className="flex gap-3">
        <button type="button" onClick={onBack} className="py-3 px-4 bg-gray-800 text-gray-300 font-semibold rounded-xl hover:bg-gray-700 transition-all duration-200 text-sm">Back</button>
        <button type="submit" disabled={loading} className="flex-1 py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 transition-all duration-200 text-sm flex items-center justify-center">
          {loading ? <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : 'Connect'}
        </button>
      </div>
    </form>
  );
}
