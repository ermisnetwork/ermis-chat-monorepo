import React, { useState, useRef, useEffect } from 'react';
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk';
import { LS_USER_ID_KEY, LS_USER_TOKEN_KEY, LS_API_KEY, LS_PROJECT_ID, LS_BASE_URL } from './constants';
import { parseJwt } from './utils';

export function OtpLoginStep({ onConnect, onBack, apiKey, projectId, baseUrl }: any) {
  const [identifier, setIdentifier] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const authProviderRef = useRef<ErmisAuthProvider | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (otpSent && countdown > 0) {
      timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [otpSent, countdown]);

  const handleSendOtp = async (e: React.FormEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError('Please enter email or phone number');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const provider = new ErmisAuthProvider(apiKey.trim(), baseUrl.trim());
      authProviderRef.current = provider;
      const isEmail = identifier.includes('@');
      
      let res;
      if (isEmail) {
        res = await provider.sendOtpToEmail(identifier.trim());
      } else {
        res = await provider.sendOtpToPhone(identifier.trim(), 'Sms');
      }

      if (res && res.success !== false) {
        setOtpSent(true);
        setCountdown(60);
      } else {
        setError(res.message || 'Failed to send OTP');
      }
    } catch (err: any) {
      setError(err?.message || 'Error sending OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode.trim()) {
      setError('Please enter OTP');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const provider = authProviderRef.current;
      if (!provider) throw new Error('Auth provider not initialized');

      const res = await provider.verifyOtp(otpCode.trim()) as any;
      if (res && res.success !== false) {
        const token = res.token || res.data?.token || res.access_token;
        if (!token) throw new Error('No token returned from OTP login');

        const payload = parseJwt(token);
        const finalUserId = res.user_id || res.user?.id || res.data?.user?.id || payload.user_id || payload.sub || payload.id;
        
        if (!finalUserId) throw new Error('Could not identify user from token');

        await onConnect(finalUserId, token, false, apiKey.trim(), projectId.trim(), baseUrl.trim());

        localStorage.setItem(LS_USER_ID_KEY, finalUserId);
        localStorage.setItem(LS_USER_TOKEN_KEY, token);
        localStorage.setItem(LS_API_KEY, apiKey.trim());
        localStorage.setItem(LS_PROJECT_ID, projectId.trim());
        localStorage.setItem(LS_BASE_URL, baseUrl.trim());
      } else {
        setError(res.message || 'Failed to verify OTP');
        setLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || 'Error verifying OTP');
      setLoading(false);
    }
  };

  return (
    <div>
      {error && <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>}
      {!otpSent ? (
        <form onSubmit={handleSendOtp}>
          <div className="mb-6">
            <label htmlFor="identifier" className="block text-sm font-medium text-gray-300 mb-2">Email or Phone Number</label>
            <input id="identifier" type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="user@example.com or +849..." className="w-full px-4 py-3 bg-gray-800/60 border border-gray-600/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onBack} className="py-3 px-4 bg-gray-800 text-gray-300 font-semibold rounded-xl hover:bg-gray-700 transition-all duration-200 text-sm">Back</button>
            <button type="submit" disabled={loading} className="flex-1 py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 transition-all duration-200 text-sm flex items-center justify-center">
              {loading ? <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : 'Send OTP'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtp}>
          <div className="mb-8 flex flex-col items-center">
            <label className="block text-sm font-medium text-gray-300 mb-4">Enter 6-digit OTP Code</label>
            <div className="flex gap-2 justify-center w-full">
              {Array.from({ length: 6 }).map((_, idx) => (
                <input
                  key={idx}
                  id={`otp-input-${idx}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={otpCode[idx] || ''}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '');
                    if (!val) return;
                    
                    const newOtp = otpCode.split('');
                    newOtp[idx] = val;
                    const finalOtp = newOtp.join('');
                    setOtpCode(finalOtp.slice(0, 6));

                    // Auto-focus next
                    if (val && idx < 5) {
                      const next = document.getElementById(`otp-input-${idx + 1}`);
                      next?.focus();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace') {
                      e.preventDefault();
                      const newOtp = otpCode.split('');
                      newOtp[idx] = '';
                      setOtpCode(newOtp.join(''));
                      // Auto-focus prev
                      if (idx > 0) {
                        const prev = document.getElementById(`otp-input-${idx - 1}`);
                        prev?.focus();
                      }
                    }
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
                    if (pasted) {
                      setOtpCode(pasted);
                      const focusIdx = Math.min(pasted.length, 5);
                      document.getElementById(`otp-input-${focusIdx}`)?.focus();
                    }
                  }}
                  className="w-12 h-14 text-center text-xl font-bold bg-gray-800/60 border border-gray-600/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all duration-200"
                />
              ))}
            </div>
            <div className="mt-4 text-gray-400 text-sm">
              We've sent a verification code to your device.
            </div>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setOtpSent(false); setCountdown(0); setOtpCode(''); }} className="py-3 px-4 bg-gray-800 text-gray-300 font-semibold rounded-xl hover:bg-gray-700 transition-all duration-200 text-sm">Back</button>
            <button type="button" disabled={countdown > 0 || loading} onClick={handleSendOtp} className="py-3 px-4 bg-gray-800 text-gray-300 font-semibold rounded-xl hover:bg-gray-700 disabled:opacity-50 transition-all duration-200 text-sm whitespace-nowrap">
              {countdown > 0 ? `Resend in ${countdown}s` : 'Resend OTP'}
            </button>
            <button type="submit" disabled={loading || otpCode.length < 6} className="flex-1 py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 transition-all duration-200 text-sm flex items-center justify-center">
              {loading ? <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : 'Login'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
