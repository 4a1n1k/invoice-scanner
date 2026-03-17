    const outputBuffer: Buffer = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Use ArrayBuffer slice to avoid SharedArrayBuffer type incompatibility
    const arrayBuf = outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength
    ) as ArrayBuffer;
    return { blob: new Blob([arrayBuf], { type: "image/jpeg" }), filename: originalName };