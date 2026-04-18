// controllers/uploadController.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../utils/database');

// Store chunk uploads temporarily
const chunkUploads = new Map();

class UploadController {
  async uploadToTelegram(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const file = req.file;
      const channelUsername = req.body.channelUsername || process.env.TELEGRAM_CHANNEL_USERNAME;
      
      // Check file size (2GB limit)
      if (file.size > 2 * 1024 * 1024 * 1024) {
        return res.status(400).json({ error: 'File exceeds 2GB limit' });
      }

      // Generate unique file ID
      const fileId = `${Date.now()}_${file.originalname}`;
      
      // Store file info in MySQL
      const [result] = await pool.execute(
        `INSERT INTO file_uploads (file_id, file_name, file_size, mime_type, channel_username, status, created_at) 
         VALUES (?, ?, ?, ?, ?, 'uploading', NOW())`,
        [fileId, file.originalname, file.size, file.mimetype, channelUsername]
      );

      // Store file temporarily
      const pendingDir = path.join(__dirname, '../uploads/pending');
      if (!fs.existsSync(pendingDir)) {
        fs.mkdirSync(pendingDir, { recursive: true });
      }
      
      const filePath = path.join(pendingDir, fileId);
      fs.writeFileSync(filePath, file.buffer);

      // Trigger background job to upload to Telegram
      await this.queueTelegramUpload(fileId, file.originalname, channelUsername);

      res.status(202).json({
        success: true,
        message: 'File queued for upload to Telegram',
        fileId: fileId,
        fileSize: file.size,
        fileName: file.originalname
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async queueTelegramUpload(fileId, fileName, channelUsername) {
    setTimeout(async () => {
      try {
        // Read from local storage
        const filePath = path.join(__dirname, '../uploads/pending', fileId);
        
        if (!fs.existsSync(filePath)) {
          throw new Error('File not found');
        }
        
        const fileBuffer = fs.readFileSync(filePath);
        
        console.log(`Processing upload for ${fileName} to ${channelUsername}`);
        
        // Update status in MySQL
        await pool.execute(
          `UPDATE file_uploads 
           SET status = 'completed', 
               telegram_url = ?,
               updated_at = NOW()
           WHERE file_id = ?`,
          [`https://t.me/${channelUsername}/${fileId}`, fileId]
        );
        
        // Clean up pending file
        fs.unlinkSync(filePath);
          
      } catch (error) {
        console.error(`Failed to upload ${fileId}:`, error);
        await pool.execute(
          `UPDATE file_uploads 
           SET status = 'failed', 
               error_message = ?,
               updated_at = NOW()
           WHERE file_id = ?`,
          [error.message, fileId]
        );
      }
    }, 100);
  }

  async uploadChunkedStart(req, res) {
    try {
      const { fileName, fileSize, totalChunks } = req.body;
      const uploadId = `${Date.now()}_${fileName}`;
      
      chunkUploads.set(uploadId, {
        fileName,
        fileSize,
        totalChunks,
        chunks: new Map(),
        completed: false
      });
      
      res.json({ uploadId });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async uploadChunkedProcess(req, res) {
    try {
      const { uploadId, chunkIndex, totalChunks } = req.body;
      const chunk = req.file;
      
      if (!chunkUploads.has(uploadId)) {
        return res.status(404).json({ error: 'Upload session not found' });
      }
      
      const upload = chunkUploads.get(uploadId);
      upload.chunks.set(chunkIndex, chunk.buffer);
      
      // Check if all chunks received
      if (upload.chunks.size === parseInt(totalChunks)) {
        // Combine chunks
        const completeBuffer = Buffer.concat(Array.from(upload.chunks.values()));
        
        // Save to local storage
        const uploadsDir = path.join(__dirname, '../uploads/chunks');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const filePath = path.join(uploadsDir, uploadId);
        fs.writeFileSync(filePath, completeBuffer);
        
        // Insert into database
        await pool.execute(
          `INSERT INTO file_uploads (file_id, file_name, file_size, mime_type, channel_username, status, created_at) 
           VALUES (?, ?, ?, ?, ?, 'processing', NOW())`,
          [uploadId, upload.fileName, upload.fileSize, 'application/octet-stream', process.env.TELEGRAM_CHANNEL_USERNAME]
        );
        
        // Queue for Telegram upload
        await this.queueTelegramUpload(uploadId, upload.fileName, process.env.TELEGRAM_CHANNEL_USERNAME);
        
        // Clean up
        chunkUploads.delete(uploadId);
        
        res.json({ 
          success: true, 
          message: 'Upload completed and queued for Telegram',
          fileId: uploadId 
        });
      } else {
        res.json({ 
          success: true, 
          message: `Chunk ${chunkIndex + 1}/${totalChunks} uploaded`,
          progress: (upload.chunks.size / totalChunks) * 100
        });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getUploadStatus(req, res) {
    try {
      const { fileId } = req.params;
      
      const [rows] = await pool.execute(
        'SELECT * FROM file_uploads WHERE file_id = ?',
        [fileId]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      res.json(rows[0]);
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new UploadController();