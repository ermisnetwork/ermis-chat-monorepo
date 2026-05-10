import heic2any from 'heic2any';
import imageCompression from 'browser-image-compression';

/**
 * Xử lý file ảnh avatar:
 * 1. Chuyển đổi HEIC/HEIF sang JPEG nếu cần.
 * 2. Nén ảnh để giảm dung lượng (giới hạn 1MB, tối đa 1280px).
 * 
 * @param file File gốc được chọn từ input
 * @returns Promise<File> File đã được xử lý
 */
export async function processAvatarFile(file: File): Promise<File> {
  let processedFile = file;

  // 1. Kiểm tra và chuyển đổi HEIC/HEIF
  const isHeic = 
    file.type === 'image/heic' || 
    file.type === 'image/heif' || 
    file.name.toLowerCase().endsWith('.heic') || 
    file.name.toLowerCase().endsWith('.heif');

  if (isHeic) {
    try {
      const blob = await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.8
      });
      
      const resultBlob = Array.isArray(blob) ? blob[0] : blob;
      
      // Chuyển đổi Blob thành File
      processedFile = new File(
        [resultBlob], 
        file.name.replace(/\.(heic|heif)$/i, '.jpg'), 
        { type: 'image/jpeg' }
      );
    } catch (error) {
      console.error('[ImageProcess] Lỗi khi chuyển đổi HEIC:', error);
    }
  }

  // 2. Nén ảnh
  const compressionOptions = {
    maxSizeMB: 1,
    maxWidthOrHeight: 1280,
    useWebWorker: true,
    fileType: 'image/jpeg'
  };

  try {
    const compressedBlob = await imageCompression(processedFile, compressionOptions);
    
    const finalFile = new File(
      [compressedBlob], 
      processedFile.name, 
      { type: 'image/jpeg', lastModified: Date.now() }
    );
    
    return finalFile;
  } catch (error) {
    console.error('[ImageProcess] Lỗi khi nén ảnh:', error);
    return processedFile;
  }
}
