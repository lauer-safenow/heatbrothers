-- Add is_home column (0 = not home, 1 = home)
ALTER TABLE "saved_views" ADD COLUMN "is_home" INTEGER NOT NULL DEFAULT 0;
