/**
 * Typed configuration factory for @nestjs/config.
 * All environment variables are validated and typed here so the rest of
 * the application can rely on strong types instead of process.env strings.
 */
export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  /** Static API key — sent by Flutter clients in the x-api-key header */
  apiKey: process.env.API_KEY ?? '',

  database: {
    url: process.env.DATABASE_URL ?? 'file:./dev.db',
  },

  whatsapp: {
    /**
     * Directory where Baileys stores multi-file auth state (credentials,
     * keys, etc.). Configurable via BAILEYS_AUTH_DIR or AUTH_STATE_DIR.
     */
    authStateDir:
      process.env.BAILEYS_AUTH_DIR ??
      process.env.AUTH_STATE_DIR ??
      './auth_state',
  },

  media: {
    /** Local directory for downloaded incoming media files */
    uploadDir: process.env.MEDIA_UPLOAD_DIR ?? './uploads',
    /**
     * When true, view-once media messages are downloaded and stored
     * permanently, bypassing WhatsApp's ephemeral single-view mechanism.
     * Set SAVE_VIEW_ONCE_MEDIA=false in .env to disable.
     */
    saveViewOnceMedia: (process.env.SAVE_VIEW_ONCE_MEDIA ?? 'true') === 'true',
  },
});
