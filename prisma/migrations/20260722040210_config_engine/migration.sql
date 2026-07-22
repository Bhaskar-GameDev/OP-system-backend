-- CreateTable
CREATE TABLE "hospital_config" (
    "id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hospital_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hospital_config_key_idx" ON "hospital_config"("key");

-- CreateIndex
CREATE UNIQUE INDEX "hospital_config_scope_type_scope_id_key_key" ON "hospital_config"("scope_type", "scope_id", "key");
