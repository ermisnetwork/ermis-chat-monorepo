import React, { useState } from 'react';
import { ConfigStep } from './ConfigStep';
import { CustomLoginStep } from './CustomLoginStep';
import { OtpLoginStep } from './OtpLoginStep';
import { DEFAULT_API_KEY, DEFAULT_PROJECT_ID, DEFAULT_BASE_URL, LS_API_KEY, LS_PROJECT_ID, LS_BASE_URL } from './constants';

export function LoginForm({ onConnect }: { onConnect: (userId: string, token: string, externalAuth: boolean, apiKey: string, projectId: string, baseUrl: string) => void }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_API_KEY) ?? DEFAULT_API_KEY);
  const [projectId, setProjectId] = useState(() => localStorage.getItem(LS_PROJECT_ID) ?? DEFAULT_PROJECT_ID);
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(LS_BASE_URL) ?? DEFAULT_BASE_URL);

  const [step, setStep] = useState(1);
  const [loginMode, setLoginMode] = useState<'custom' | 'otp'>('custom');
  const [globalError, setGlobalError] = useState('');

  const handleConfigNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || !projectId.trim() || !baseUrl.trim()) {
      setGlobalError('Please fill in all config fields.');
      return;
    }
    setGlobalError('');
    setStep(2);
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-indigo-950">
      <div className="w-full max-w-md mx-4">
        {/* Glowing card */}
        <div className="relative">
          <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-2xl blur-lg opacity-30 animate-pulse" />
          <div className="relative bg-gray-900/80 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-8 shadow-2xl">
            
            {/* Logo / Title */}
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 mb-4 shadow-lg shadow-indigo-500/25">
                <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Ermis Chat Demo</h1>
              <p className="text-gray-400 text-sm mt-1">Enter your credentials to connect</p>
            </div>

            {globalError && (
              <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
                {globalError}
              </div>
            )}

            {step === 1 ? (
              <ConfigStep 
                apiKey={apiKey} setApiKey={setApiKey} 
                projectId={projectId} setProjectId={setProjectId} 
                baseUrl={baseUrl} setBaseUrl={setBaseUrl} 
                onNext={handleConfigNext} 
              />
            ) : (
              <div>
                {/* Tabs */}
                <div className="flex rounded-xl bg-gray-800/50 p-1 mb-6">
                  <button onClick={() => setLoginMode('custom')} className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${loginMode === 'custom' ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400 hover:text-gray-200'}`}>
                    User Token
                  </button>
                  <button onClick={() => setLoginMode('otp')} className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${loginMode === 'otp' ? 'bg-indigo-500/20 text-indigo-300' : 'text-gray-400 hover:text-gray-200'}`}>
                    OTP Login
                  </button>
                </div>

                {loginMode === 'custom' ? (
                  <CustomLoginStep onConnect={onConnect} onBack={() => setStep(1)} apiKey={apiKey} projectId={projectId} baseUrl={baseUrl} />
                ) : (
                  <OtpLoginStep onConnect={onConnect} onBack={() => setStep(1)} apiKey={apiKey} projectId={projectId} baseUrl={baseUrl} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
