# Cloudinary image storage

The media API stores new image uploads in Cloudinary and keeps searchable metadata in MongoDB.

## Render environment variables

Set these variables on the Render backend service `nkbike`:

```env
CLOUDINARY_CLOUD_NAME=fvkjvjvl
CLOUDINARY_API_KEY=122484677454153
CLOUDINARY_API_SECRET=DIEN_API_SECRET_CUA_BAN
```

Replace `DIEN_API_SECRET_CUA_BAN` with the API Secret from Cloudinary Console → Settings → API Keys. Do not commit the API Secret to GitHub, put it in the frontend, or send it in chat.

After saving the variables, redeploy/restart the backend. Set them on the backend service `nkbike`, not the frontend service `nk-admin`.

## Admin image library

Admin page: `/admin/images`.

All endpoints require `Authorization: Bearer <adminToken>`:

- `GET /api/media?page=1&limit=48` — list images with pagination.
- `GET /api/media?q=filename&folder=products` — search and filter.
- `POST /api/media/upload` — multipart upload; use `images` for file fields and `folder` for the destination folder.
- `PATCH /api/media/:id` — update alt text or folder.
- `DELETE /api/media/:id` — delete an image after checking that no product references its URL.

Supported formats: JPG, PNG, WEBP, GIF. Maximum 20 files per request and 12 MB per file.

## Storage behavior

- New uploads go to the Cloudinary folder `nhat-khang-bike/<folder>`.
- MongoDB collection `media` stores each image URL, Cloudinary public ID, provider, MIME type, size, and folder.
- Old media records without `storageProvider` continue to be treated as Cloudflare R2 records when deleted. Existing product image URLs are not migrated or changed.
- Deleting a media record still checks whether its URL is referenced by a product before removing the remote image.
- Both the media library and legacy product image upload code use `CLOUDINARY_CLOUD_NAME`; the legacy `CLOUDINARY_NAME` variable remains supported as a fallback.
