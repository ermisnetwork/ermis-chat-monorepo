import React from 'react';

export function ConfigStep({ apiKey, setApiKey, projectId, setProjectId, baseUrl, setBaseUrl, onNext }: any) {
  return (
    <form onSubmit={onNext}>
      <div className="mb-5">
        <label htmlFor="baseUrl" className="block text-sm font-medium text-gray-300 mb-2">Base URL</label>
        <input id="baseUrl" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
      </div>
      <div className="mb-5">
        <label htmlFor="apiKey" className="block text-sm font-medium text-gray-300 mb-2">API Key</label>
        <input id="apiKey" type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Your API Key" className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
      </div>
      <div className="mb-6">
        <label htmlFor="projectId" className="block text-sm font-medium text-gray-300 mb-2">Project ID</label>
        <input id="projectId" type="text" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Your Project ID" className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
      </div>
      <button type="submit" className="w-full py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 shadow-lg shadow-indigo-500/25 transition-all duration-200 text-sm">
        Next
      </button>
    </form>
  );
}
