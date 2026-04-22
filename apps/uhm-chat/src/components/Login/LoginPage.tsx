import React, { useState, useRef, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { GoogleLogin } from '@react-oauth/google'
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

interface LoginPageProps {
  onLoginSuccess: (userId: string, token: string) => void
}

function parseJwt(token: string) {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    return JSON.parse(jsonPayload)
  } catch (e) {
    return null
  }
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [loginMode, setLoginMode] = useState<'email' | 'phone'>('email')
  const [identifier, setIdentifier] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(0)
  const authProviderRef = useRef<ErmisAuthProvider | null>(null)

  useEffect(() => {
    let timer: NodeJS.Timeout
    if (otpSent && countdown > 0) {
      timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    }
    return () => clearTimeout(timer)
  }, [otpSent, countdown])

  const validateEmail = (email: string) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return re.test(email)
  }

  const validatePhone = (phone: string) => {
    const cleaned = phone.replace(/\D/g, '')
    return cleaned.length >= 9 && cleaned.length <= 11
  }

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    
    let finalIdentifier = identifier.trim()
    
    if (loginMode === 'email') {
      if (!identifier.trim() || !validateEmail(identifier)) {
        setError('Vui lòng nhập định dạng Email hợp lệ')
        return
      }
    } else {
      if (!identifier.trim() || !validatePhone(identifier)) {
        setError('Số điện thoại phải từ 9-11 chữ số')
        return
      }
      let phoneNum = identifier.replace(/\D/g, '')
      if (phoneNum.startsWith('0')) {
        phoneNum = phoneNum.substring(1)
      }
      finalIdentifier = `+84${phoneNum}`
    }
    
    setError('')
    setLoading(true)

    try {
      const API_KEY = import.meta.env.VITE_API_KEY || 'uhm-chat-dev-key'
      const BASE_URL = import.meta.env.VITE_API_URL || 'https://api-trieve.ermis.network'
      const provider = new ErmisAuthProvider(API_KEY, BASE_URL)
      authProviderRef.current = provider

      let res
      if (loginMode === 'email') {
        res = await provider.sendOtpToEmail(finalIdentifier)
      } else {
        res = await provider.sendOtpToPhone(finalIdentifier, 'Sms')
      }

      if (res && res.success !== false) {
        setOtpSent(true)
        setCountdown(60)
        setOtpCode('') // reset code
      } else {
        setError(res.message || 'Gửi mã OTP thất bại')
      }
    } catch (err: any) {
      setError(err?.message || 'Lỗi hệ thống khi gửi OTP')
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otpCode.length < 6) {
      setError('Vui lòng nhập đủ mã OTP 6 số')
      return
    }
    setError('')
    setLoading(true)

    try {
      const provider = authProviderRef.current
      if (!provider) throw new Error('Phiên xác thực không hợp lệ. Vui lòng thử lại.')

      const res = await provider.verifyOtp(otpCode) as any
      if (res && res.success !== false) {
        const token = res.token || res.data?.token || res.access_token
        if (!token) throw new Error('Không tìm thấy token đăng nhập')

        const payload = parseJwt(token)
        const finalUserId = res.user_id || res.user?.id || res.data?.user?.id || payload?.user_id || payload?.sub || payload?.id

        if (!finalUserId) throw new Error('Không thể xác định danh tính User')

        onLoginSuccess(finalUserId, token)
      } else {
        setError(res.message || 'Mã OTP không chính xác')
      }
    } catch (err: any) {
      setError(err?.message || 'Lỗi hệ thống khi xác thực OTP')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSuccess = async (credentialResponse: any) => {
    setError('')
    setLoading(true)
    try {
      const API_KEY = import.meta.env.VITE_API_KEY || 'uhm-chat-dev-key'
      const BASE_URL = import.meta.env.VITE_API_URL || 'https://api-trieve.ermis.network'
      const provider = new ErmisAuthProvider(API_KEY, BASE_URL)
      
      const res = await provider.loginWithGoogle(credentialResponse.credential) as any
      if (res && res.success !== false) {
        const token = res.token || res.data?.token || res.access_token
        if (!token) throw new Error('Không tìm thấy token đăng nhập')

        const payload = parseJwt(token)
        const finalUserId = res.user_id || res.user?.id || res.data?.user?.id || payload?.user_id || payload?.sub || payload?.id
        
        onLoginSuccess(finalUserId, token)
      } else {
        setError(res.message || 'Đăng nhập Google thất bại')
      }
    } catch (err: any) {
      setError(err?.message || 'Lỗi hệ thống khi đăng nhập Google')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Cột trái: Giới thiệu (Chỉ hiển thị trên màn hình lớn) */}
      <div className="hidden lg:flex w-1/2 flex-col justify-between bg-zinc-900 p-12 text-white relative overflow-hidden">
        {/* Background decorations */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute -top-1/4 -left-1/4 w-[40rem] h-[40rem] rounded-full bg-purple-600/20 blur-[120px]" />
          <div className="absolute bottom-1/4 right-0 w-[30rem] h-[30rem] rounded-full bg-blue-600/20 blur-[100px]" />
        </div>
        
        <div className="relative z-10">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 shadow-xl shadow-purple-500/30 mb-8">
            <span className="text-3xl font-extrabold tracking-tighter text-white">U</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl lg:leading-[1.15]">
            Kết nối trọn vẹn,<br />
            <span className="bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">Trò chuyện dễ dàng.</span>
          </h1>
          <p className="mt-6 text-lg text-zinc-400 max-w-md leading-relaxed">
            Uhm Chat mang đến trải nghiệm nhắn tin thời gian thực nhanh chóng, an toàn và bảo mật hoàn đối cho mọi thiết bị của bạn.
          </p>
        </div>
        
        <div className="relative z-10">
          <div className="text-sm font-medium text-zinc-500">
            © 2026 Uhm Chat by Ermis Network. All rights reserved.
          </div>
        </div>
      </div>

      {/* Cột phải: Form đăng nhập */}
      <div className="flex w-full lg:w-1/2 items-center justify-center p-4 lg:p-12 relative overflow-hidden">
        {/* Background decoration for mobile */}
        <div className="lg:hidden pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[30rem] w-[30rem] rounded-full bg-purple-500/10 blur-[100px]" />
        </div>

        <div className="z-10 w-full max-w-md">
          {/* Logo cho mobile */}
          <div className="mb-8 flex lg:hidden justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 shadow-lg shadow-purple-500/30">
              <span className="text-2xl font-bold text-white">U</span>
            </div>
          </div>

          <Card className="border-white/20 bg-white/60 shadow-xl backdrop-blur-xl dark:border-zinc-800/50 dark:bg-zinc-900/60 lg:border-none lg:shadow-none lg:bg-transparent lg:backdrop-blur-none lg:dark:bg-transparent">
            <CardHeader className="space-y-2 text-center lg:text-left lg:px-0">
              <CardTitle className="text-3xl font-bold tracking-tight">
                Chào mừng trở lại
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-zinc-400 text-base">
                Đăng nhập vào Uhm Chat để tiếp tục
              </CardDescription>
            </CardHeader>
            <CardContent className="lg:px-0 mt-4">
              {error && (
                <div className="mb-6 rounded-md bg-destructive/10 p-3 text-sm text-destructive border border-destructive/20 text-center font-medium">
                  {error}
                </div>
              )}

              {!otpSent ? (
                <div className="space-y-5">
                  <Tabs value={loginMode} onValueChange={(v) => {
                    setLoginMode(v as 'email' | 'phone')
                    setIdentifier('')
                    setError('')
                  }} className="w-full">
                    <TabsList className="relative mb-4 grid w-full grid-cols-2 p-1 bg-zinc-100 dark:bg-zinc-800/50 rounded-xl h-12">
                      <div
                        className={`absolute left-1 top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-lg bg-white dark:bg-zinc-900 shadow-sm transition-transform duration-300 ease-out ${loginMode === 'phone' ? 'translate-x-full' : 'translate-x-0'}`}
                      />
                      <TabsTrigger value="email" className="relative z-10 rounded-lg py-2 data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-colors font-medium text-zinc-500 dark:text-zinc-400 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-50">Email</TabsTrigger>
                      <TabsTrigger value="phone" className="relative z-10 rounded-lg py-2 data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-colors font-medium text-zinc-500 dark:text-zinc-400 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-50">Số điện thoại</TabsTrigger>
                    </TabsList>
                    
                    <form onSubmit={handleSendOtp} className="space-y-5">
                      <TabsContent value="email" className="mt-0 space-y-2 outline-none">
                        <Label htmlFor="email" className="text-zinc-700 dark:text-zinc-300">Nhập địa chỉ Email</Label>
                        <Input 
                          id="email" 
                          type="email" 
                          value={identifier}
                          onChange={(e) => setIdentifier(e.target.value)}
                          placeholder="name@example.com" 
                          disabled={loading}
                          required 
                          className="bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 h-11"
                        />
                      </TabsContent>

                      <TabsContent value="phone" className="mt-0 space-y-2 outline-none">
                        <Label htmlFor="phone" className="text-zinc-700 dark:text-zinc-300">Nhập số điện thoại di động</Label>
                        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-transparent transition-all h-11">
                          <div className="flex items-center justify-center bg-zinc-50 dark:bg-zinc-900/80 px-3 border-r border-zinc-200 dark:border-zinc-800">
                            <span className="mr-2 text-base select-none">🇻🇳</span>
                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 select-none">+84</span>
                          </div>
                          <input 
                            id="phone"
                            type="tel"
                            value={identifier}
                            onChange={(e) => setIdentifier(e.target.value)}
                            className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none placeholder:text-muted-foreground"
                            placeholder="987 654 321"
                            disabled={loading}
                            required
                          />
                        </div>
                      </TabsContent>

                      <Button type="submit" disabled={loading} className="w-full h-11 bg-purple-600 hover:bg-purple-700 text-white font-medium text-base transition-colors">
                        {loading ? 'Đang gửi...' : 'Gửi mã OTP'}
                      </Button>
                    </form>
                  </Tabs>
                </div>
              ) : (
                <form onSubmit={handleVerifyOtp} className="space-y-8">
                  <div className="space-y-6">
                    <div className="text-center lg:text-left">
                      <Label className="text-base text-zinc-700 dark:text-zinc-300">Nhập mã OTP 6 số</Label>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
                        Mã xác nhận đã được gửi đến <span className="font-medium text-zinc-900 dark:text-zinc-100">{identifier}</span>
                      </p>
                    </div>
                    
                    <div className="flex justify-center lg:justify-start gap-2 sm:gap-3">
                      {Array.from({ length: 6 }).map((_, idx) => (
                        <Input
                          key={idx}
                          id={`otp-input-${idx}`}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={otpCode[idx] || ''}
                          disabled={loading}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '')
                            if (!val) return
                            
                            const newOtp = otpCode.split('')
                            newOtp[idx] = val
                            const finalOtp = newOtp.join('')
                            setOtpCode(finalOtp.slice(0, 6))

                            if (val && idx < 5) {
                              const next = document.getElementById(`otp-input-${idx + 1}`)
                              next?.focus()
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Backspace') {
                              e.preventDefault()
                              const newOtp = otpCode.split('')
                              newOtp[idx] = ''
                              setOtpCode(newOtp.join(''))
                              if (idx > 0) {
                                const prev = document.getElementById(`otp-input-${idx - 1}`)
                                prev?.focus()
                              }
                            }
                          }}
                          onPaste={(e) => {
                            e.preventDefault()
                            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
                            if (pasted) {
                              setOtpCode(pasted)
                              const focusIdx = Math.min(pasted.length, 5)
                              document.getElementById(`otp-input-${focusIdx === 6 ? 5 : focusIdx}`)?.focus()
                            }
                          }}
                          className="h-12 w-10 sm:h-14 sm:w-12 text-center text-xl font-bold bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <Button type="submit" disabled={loading || otpCode.length < 6} className="w-full h-11 bg-purple-600 hover:bg-purple-700 text-white font-medium text-base transition-colors">
                      {loading ? 'Đang xác thực...' : 'Đăng nhập'}
                    </Button>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" disabled={loading} onClick={() => setOtpSent(false)} className="flex-1 h-11 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300">
                        Quay lại
                      </Button>
                      <Button type="button" variant="secondary" disabled={countdown > 0 || loading} onClick={handleSendOtp} className="flex-1 h-11 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300">
                        {countdown > 0 ? `Gửi lại (${countdown}s)` : 'Gửi lại OTP'}
                      </Button>
                    </div>
                  </div>
                </form>
              )}

              {!otpSent && (
                <>
                  <div className="relative my-8">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-zinc-200 dark:border-zinc-800" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-zinc-50 dark:bg-zinc-950 px-2 text-zinc-500 dark:text-zinc-400 font-medium lg:bg-transparent">
                        Hoặc tiếp tục với
                      </span>
                    </div>
                  </div>

                  <div className="flex justify-center">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={() => setError('Không thể kết nối với Google')}
                      theme="outline"
                      shape="rectangular"
                      width="100%"
                      locale="vi"
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
