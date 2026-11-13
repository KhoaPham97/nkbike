# Cloudflare R2 setup for Nhật Khang Bike

The media API stores image files in Cloudflare R2 and metadata in MongoDB.

## 1. Create an R2 bucket

Create a bucket in Cloudflare Dashboard, for example: nkbike-media.

Create an R2 API token with Object Read & Write permissions restricted to this bucket. Keep the Access Key ID and Secret Access Key private.

Enable public read access using a custom domain, for example images.your-domain.vn. Set the domain as the bucket's public custom domain. Do not use the S3 API endpoint as the public image URL.

## 2. Configure Render environment variables

Add these variables to the backend service:

- R2_ACCOUNT_ID: Cloudflare account ID
- R2_ACCESS_KEY_ID: R2 Access Key ID
- R2_SECRET_ACCESS_KEY: R2 Secret Access Key
- R2_BUCKET_NAME: bucket name, e.g. nkbike-media
- R2_PUBLIC_URL: public custom domain base URL, e.g. https://images.your-domain.vn (no trailing slash)

Never commit real credentials to GitHub or expose them in the admin frontend.

## 3. R2 CORS

Uploads are sent to the backend API, so browser PUT CORS is not needed on R2. The public custom domain serves image GET requests.

## 4. API

All endpoints require an admin Bearer token:

- GET /api/media?page=1&limit=40&q=keyword
- POST /api/media/upload with multipart field images (up to 20 files, 12 MB each); optional folder
- PATCH /api/media/:id with alt and/or folder
- DELETE /api/media/:id

Delete is blocked while the URL is referenced by a product thumbnail, product images, or a variant image.

## 5. Existing images

Existing product image URLs are not changed. Upload new images to R2 and copy their URL into product fields. Existing Cloudinary and local image paths continue working.
