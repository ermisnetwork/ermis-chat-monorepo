import { Helmet } from 'react-helmet-async'

interface SEOProps {
  title?: string
  description?: string
  image?: string
  url?: string
}

export function SEO({ title, description, image, url }: SEOProps) {
  const defaultTitle = 'Uhm Chat'
  const defaultDescription = 'Uhm Chat - Ứng dụng nhắn tin nhanh chóng, bảo mật và hiện đại. Kết nối với bạn bè và đồng nghiệp mọi lúc, mọi nơi.'
  const defaultImage = '/uhm-preview.png'
  const defaultUrl = 'https://uhm.chat/'

  const seoTitle = title ? `${title}` : defaultTitle
  const seoDescription = description || defaultDescription
  const seoImage = image || defaultImage
  const seoUrl = url || defaultUrl

  return (
    <Helmet>
      <title>{seoTitle}</title>
      <meta name="description" content={seoDescription} />
      <meta name="title" content={seoTitle} />

      {/* Open Graph */}
      <meta property="og:title" content={seoTitle} />
      <meta property="og:description" content={seoDescription} />
      <meta property="og:image" content={seoImage} />
      <meta property="og:url" content={seoUrl} />

      {/* Twitter */}
      <meta property="twitter:title" content={seoTitle} />
      <meta property="twitter:description" content={seoDescription} />
      <meta property="twitter:image" content={seoImage} />
      <meta property="twitter:url" content={seoUrl} />
    </Helmet>
  )
}
