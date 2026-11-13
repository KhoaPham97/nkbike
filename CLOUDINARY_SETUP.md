# Cloudinary image storage

The media API stores new image uploads in Cloudinary and keeps searchable metadata in MongoDB.

## Render environment variables

Set these variables on the Render backend service:

- `CLOUDINARY_CLOUD_NAME`: Cloud name from the Cloudinary dashboard
- `CLOUDINARY_API_KEY`: API Key from Product Environment Credentials
- `CLOUDINARY_API_SECRET`: API Secret from Product Environment Credentials

Do not commit these values to GitHub or send the API Secret in chat.

After saving the variables, redeploy/restart the backend. The admin image library remains at `/admin/images` and uploads through `POST /api/media/upload`.

## Storage behavior

- New uploads go to the Cloudinary folder `nhat-khang-bike/<folder>`.
- MongoDB collection `media` stores each image URL, Cloudinary public ID, provider, MIME type, size, and folder.
- Old media records without `storageProvider` continue to be treated as Cloudflare R2 records when deleted. Existing product image URLs are not migrated or changed.
- Deleting a media record still checks whether its URL is referenced by a product before removing the remote image.
