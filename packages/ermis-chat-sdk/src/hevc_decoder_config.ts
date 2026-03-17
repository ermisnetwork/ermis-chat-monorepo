// 1. Định nghĩa các hằng số NAL Unit
export const NALUnitType = {
  VPS_NUT: 32,
  SPS_NUT: 33,
  PPS_NUT: 34,
  PREFIX_SEI_NUT: 39,
  SUFFIX_SEI_NUT: 40,

  fromValue(value: number): string | number {
    const types: Record<number, string> = {
      32: 'VPS_NUT',
      33: 'SPS_NUT',
      34: 'PPS_NUT',
      39: 'PREFIX_SEI_NUT',
      40: 'SUFFIX_SEI_NUT',
    };
    return types[value] || value;
  },
} as const;

// 2. Interface cho mảng NAL Unit bên trong config
export interface INALArray {
  arrayCompleteness: boolean;
  nalUnitType: string | number;
  nalus: Uint8Array[];
}

// 3. Interface cho cấu hình HEVC (giúp strict type checking)
export interface IHEVCConfig {
  generalProfileSpace: number;
  generalTierFlag: boolean;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalConstraintIndicatorFlags: number;
  generalLevelIdc: number;
  minSpatialSegmentationIdc: number;
  parallelismType: number;
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  avgFrameRate: number;
  constantFrameRate: number;
  numTemporalLayers: number;
  temporalIdNested: boolean;
  lengthSizeMinusOne: number;
  arrays: INALArray[];
}

export class HEVCDecoderConfigurationRecord implements IHEVCConfig {
  // Khai báo các thuộc tính của class
  public generalProfileSpace: number = 0;
  public generalTierFlag: boolean = false;
  public generalProfileIdc: number = 0;
  public generalProfileCompatibilityFlags: number = 0;
  public generalConstraintIndicatorFlags: number = 0;
  public generalLevelIdc: number = 0;
  public minSpatialSegmentationIdc: number = 0;
  public parallelismType: number = 0;
  public chromaFormatIdc: number = 0;
  public bitDepthLumaMinus8: number = 0;
  public bitDepthChromaMinus8: number = 0;
  public avgFrameRate: number = 0;
  public constantFrameRate: number = 0;
  public numTemporalLayers: number = 0;
  public temporalIdNested: boolean = false;
  public lengthSizeMinusOne: number = 0;
  public arrays: INALArray[] = [];

  constructor(config: IHEVCConfig) {
    Object.assign(this, config);
  }

  /**
   * Demuxes an HEVCDecoderConfigurationRecord from a byte buffer.
   * @param data - The byte data to parse
   */
  static demux(data: ArrayBuffer | Uint8Array): HEVCDecoderConfigurationRecord {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    let offset = 0;
    let bitOffset = 0;

    // Helper to read bits
    const readBits = (numBits: number): number => {
      let result = 0;
      for (let i = 0; i < numBits; i++) {
        if (offset >= buffer.length) throw new Error('End of buffer');
        const bit = (buffer[offset] >> (7 - bitOffset)) & 1;
        result = (result << 1) | bit;
        bitOffset++;
        if (bitOffset === 8) {
          bitOffset = 0;
          offset++;
        }
      }
      return result;
    };

    // Helper to read a byte
    const readU8 = (): number => {
      if (bitOffset !== 0) return readBits(8);
      if (offset >= buffer.length) throw new Error('End of buffer');
      return buffer[offset++];
    };

    // Helper to read 16-bit big-endian
    const readU16BE = (): number => {
      if (bitOffset !== 0) return readBits(16);
      const val = view.getUint16(offset, false);
      offset += 2;
      return val;
    };

    // Helper to read 32-bit big-endian
    const readU32BE = (): number => {
      if (bitOffset !== 0) return readBits(32);
      const val = view.getUint32(offset, false);
      offset += 4;
      return val;
    };

    // Helper to read 48-bit big-endian
    const readU48BE = (): number => {
      const high = readU16BE();
      const low = readU32BE();
      return high * 0x100000000 + low;
    };

    // Helper to read exact bytes
    const readExact = (length: number): Uint8Array => {
      if (bitOffset !== 0) {
        const result = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          result[i] = readBits(8);
        }
        return result;
      }
      if (offset + length > buffer.length) throw new Error('End of buffer');
      const result = buffer.slice(offset, offset + length);
      offset += length;
      return result;
    };

    // Parse configuration version
    const configurationVersion = readU8();
    if (configurationVersion !== 1) {
      throw new Error('Invalid configuration version');
    }

    // Parse profile information
    const generalProfileSpace = readBits(2);
    const generalTierFlag = readBits(1) === 1;
    const generalProfileIdc = readBits(5);
    const generalProfileCompatibilityFlags = readU32BE();
    const generalConstraintIndicatorFlags = readU48BE();
    const generalLevelIdc = readU8();

    // Parse spatial segmentation
    readBits(4); // reserved_4bits
    const minSpatialSegmentationIdc = readBits(12);

    // Parse parallelism type
    readBits(6); // reserved_6bits
    const parallelismType = readBits(2);

    // Parse chroma format
    readBits(6); // reserved_6bits
    const chromaFormatIdc = readBits(2);

    // Parse bit depth (luma)
    readBits(5); // reserved_5bits
    const bitDepthLumaMinus8 = readBits(3);

    // Parse bit depth (chroma)
    readBits(5); // reserved_5bits
    const bitDepthChromaMinus8 = readBits(3);

    // Parse frame rate and temporal information
    const avgFrameRate = readU16BE();
    const constantFrameRate = readBits(2);
    const numTemporalLayers = readBits(3);
    const temporalIdNested = readBits(1) === 1;
    const lengthSizeMinusOne = readBits(2);

    if (lengthSizeMinusOne === 2) {
      throw new Error('length_size_minus_one must be 0, 1, or 3');
    }

    // Parse NALU arrays
    const numOfArrays = readU8();
    const arrays: INALArray[] = [];

    for (let i = 0; i < numOfArrays; i++) {
      const arrayCompleteness = readBits(1) === 1;
      readBits(1); // reserved
      const nalUnitType = readBits(6);
      const nalUnitTypeName = NALUnitType.fromValue(nalUnitType);

      if (
        nalUnitType !== NALUnitType.VPS_NUT &&
        nalUnitType !== NALUnitType.SPS_NUT &&
        nalUnitType !== NALUnitType.PPS_NUT &&
        nalUnitType !== NALUnitType.PREFIX_SEI_NUT &&
        nalUnitType !== NALUnitType.SUFFIX_SEI_NUT
      ) {
        // Có thể comment dòng này nếu muốn hỗ trợ các loại NALU khác không chuẩn
        // throw new Error('Invalid nal_unit_type');
      }

      const numNalus = readU16BE();
      const nalus: Uint8Array[] = [];

      for (let j = 0; j < numNalus; j++) {
        const nalUnitLength = readU16BE();
        const naluData = readExact(nalUnitLength);
        nalus.push(naluData);
      }

      arrays.push({
        arrayCompleteness,
        nalUnitType: nalUnitTypeName,
        nalus,
      });
    }

    return new HEVCDecoderConfigurationRecord({
      generalProfileSpace,
      generalTierFlag,
      generalProfileIdc,
      generalProfileCompatibilityFlags,
      generalConstraintIndicatorFlags,
      generalLevelIdc,
      minSpatialSegmentationIdc,
      parallelismType,
      chromaFormatIdc,
      bitDepthLumaMinus8,
      bitDepthChromaMinus8,
      avgFrameRate,
      constantFrameRate,
      numTemporalLayers,
      temporalIdNested,
      lengthSizeMinusOne,
      arrays,
    });
  }

  /**
   * Converts the HEVC configuration to a codec string (RFC 6381 format).
   * @returns Codec string like "hev1.1.6.L93.B0"
   */
  toCodecString(): string {
    const profileSpaceMap: Record<number, string> = { 0: '', 1: 'A', 2: 'B', 3: 'C' };
    const generalProfileSpace = profileSpaceMap[this.generalProfileSpace];

    if (generalProfileSpace === undefined) {
      throw new Error('Unknown profile space');
    }

    const profileAndSpace = `${generalProfileSpace}${this.generalProfileIdc}`;

    // Format profile compatibility flags (reverse hex and strip trailing zeros)
    let profileCompatibilityFlagsUnfiltered = this.generalProfileCompatibilityFlags
      .toString(16)
      .padStart(8, '0')
      .split('')
      .reverse()
      .join('');

    let profileCompatibilityFlags = '';
    for (let i = 0; i < profileCompatibilityFlagsUnfiltered.length; i++) {
      const char = profileCompatibilityFlagsUnfiltered[i];
      if (char !== '0' || i === 0) {
        profileCompatibilityFlags += char;
      }
    }

    // Format tier and level
    const generalTierFlag = this.generalTierFlag ? 'H' : 'L';
    const tierAndLevel = `${generalTierFlag}${this.generalLevelIdc}`;

    // Format constraint flags (skip first 2 bytes of 48-bit value)
    let constraintFlags = '';

    // Convert 48-bit number to 6 bytes
    const constraint = this.generalConstraintIndicatorFlags;
    const bytes = [
      Math.floor(constraint / 0x10000000000) & 0xff,
      Math.floor(constraint / 0x100000000) & 0xff,
      Math.floor(constraint / 0x1000000) & 0xff,
      Math.floor(constraint / 0x10000) & 0xff,
      Math.floor(constraint / 0x100) & 0xff,
      constraint & 0xff,
    ];

    // Skip first 2 bytes (bytes[0] and bytes[1]) per Logic
    for (let i = 2; i < 6; i++) {
      if (bytes[i] !== 0) {
        constraintFlags += `.${bytes[i].toString(16).padStart(2, '0')}`;
      }
    }

    return `hev1.${profileAndSpace}.${profileCompatibilityFlags}.${tierAndLevel}${constraintFlags}`;
  }
}
