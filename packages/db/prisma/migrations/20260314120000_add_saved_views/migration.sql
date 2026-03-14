-- CreateTable
CREATE TABLE "saved_views" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- CreateIndex
CREATE INDEX "idx_saved_view_email" ON "saved_views"("email");
