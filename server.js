const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({
    origin: 'https://ssc-signature-formatter.vercel.app'
}));

const cmToPixels = (cm) => Math.round(cm * 37.7952755906); // 37.7952755906 pixels per cm

const deleteFileWithRetry = (filePath, retries = 3, delay = 1000) => {
    if (retries < 0) {
        console.error(`Failed to delete file ${filePath} after multiple attempts`);
        return;
    }

    setTimeout(() => {
        fs.unlink(filePath, (err) => {
            if (err) {
                if (err.code === 'EPERM' || err.code === 'EBUSY') {
                    // Retry deletion after a delay
                    deleteFileWithRetry(filePath, retries - 1, delay);
                } else {
                    console.error(`Error deleting file ${filePath}:`, err);
                }
            }
        });
    }, delay);
};

const cleanUpFiles = (files) => {
    setTimeout(() => {
        files.forEach(file => {
            if (fs.existsSync(file)) {
                deleteFileWithRetry(file);
            }
        });
    }, 5000);
};

app.post('/upload', upload.single('file'), async (req, res) => {
    const filePath = req.file.path;
    const tempFilePath = path.join(__dirname, 'temp', `temp_signature_${uuidv4()}.jpg`);
    const outputFilePath = path.join(__dirname, 'output', `formatted_signature_${uuidv4()}.jpg`);
    let quality = 85;
    const minSize = 10 * 1024; // 10 KB
    const maxSize = 20 * 1024; // 20 KB
    let fileSize;

    try {
        const initialStats = fs.statSync(filePath);
        fileSize = initialStats.size;

        if (fileSize >= minSize && fileSize <= maxSize) {
            // Enhance quality if the file size is already within the desired range
            await sharp(filePath)
                .resize(709, 236)
                .jpeg({ quality: 100 })
                .toFile(outputFilePath);
        } else {
            // Resize the image first
            await sharp(filePath)
                .resize(709, 236) // 4cm x 2cm in pixels
                .toFile(tempFilePath);

            do {
                const intermediateFilePath = path.join(__dirname, 'temp', `intermediate_signature_${uuidv4()}.jpg`);

                await sharp(tempFilePath)
                    .jpeg({ quality })
                    .toFile(intermediateFilePath);

                const stats = fs.statSync(intermediateFilePath);
                fileSize = stats.size;

                if (fileSize < minSize && quality < 100) {
                    quality += 5;
                } else if (fileSize > maxSize && quality > 1) {
                    quality -= 5;
                } else {
                    fs.renameSync(intermediateFilePath, outputFilePath);
                    break;
                }

                // Update tempFilePath for the next iteration
                fs.renameSync(intermediateFilePath, tempFilePath);
            } while (fileSize < minSize || fileSize > maxSize);

            // If the image is still smaller than the minimum size, upscale the image
            if (fileSize < minSize) {
                let upscaleFactor = 1.1; // Start with a 10% increase
                do {
                    const upscaledFilePath = path.join(__dirname, 'output', `upscaled_signature_${uuidv4()}.jpg`);
                    await sharp(outputFilePath)
                        .resize({
                            width: Math.round(cmToPixels(4) * upscaleFactor),
                            height: Math.round(cmToPixels(2) * upscaleFactor),
                            fit: 'contain',
                            background: { r: 255, g: 255, b: 255, alpha: 1 }
                        })
                        .jpeg({ quality: 100 })
                        .toFile(upscaledFilePath);

                    fs.renameSync(upscaledFilePath, outputFilePath);
                    const finalStats = fs.statSync(outputFilePath);
                    fileSize = finalStats.size;

                    upscaleFactor += 0.1; // Increase upscale factor for the next iteration if needed
                } while (fileSize < minSize);
            }
        }

        res.download(outputFilePath, 'formatted_signature.jpg', (err) => {
            cleanUpFiles([filePath, tempFilePath, outputFilePath]);

            if (err) {
                console.error(err);
            }
        });
    } catch (error) {
        console.error(error);
        cleanUpFiles([filePath, tempFilePath, outputFilePath]);
        res.status(500).send('Error processing image');
    }
});

// Schedule a task to delete old files in the uploads, temp, and output directories
cron.schedule('*/15 * * * *', () => {
    const deleteOldFiles = (dirPath) => {
        fs.readdir(dirPath, (err, files) => {
            if (err) {
                console.error(`Error reading directory ${dirPath}:`, err);
                return;
            }

            files.forEach(file => {
                const filePath = path.join(dirPath, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        console.error(`Error getting stats of file ${filePath}:`, err);
                        return;
                    }

                    const now = new Date().getTime();
                    const fileAge = now - stats.mtime.getTime();
                    const fifteenMinutes = 15 * 60 * 1000;

                    if (fileAge > fifteenMinutes) {
                        deleteFileWithRetry(filePath);
                    }
                });
            });
        });
    };

    deleteOldFiles(path.join(__dirname, 'uploads'));
    deleteOldFiles(path.join(__dirname, 'temp'));
    deleteOldFiles(path.join(__dirname, 'output'));
});

app.listen(5000, () => {
    console.log('Server is running on port 5000');
});


    