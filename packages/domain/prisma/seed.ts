import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prisma } from "../src/prisma";
import { seedBrandConstitutionIfChanged, seedBrandMemoryIfChanged } from "../src/brand";
import { hashPassword } from "../src/auth";
import { setFlag } from "../src/feature-flags";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

async function main() {
  const brandConstitution = readFileSync(
    join(REPO_ROOT, "brand", "BRAND_CONSTITUTION.md"),
    "utf8",
  );
  const chrisBrain = readFileSync(join(REPO_ROOT, "brand", "CHRIS_BRAIN.md"), "utf8");

  const constitutionResult = await seedBrandConstitutionIfChanged(prisma, brandConstitution);
  console.log(
    `[seed] BrandConstitutionVersion: ${
      constitutionResult.created ? "created" : "unchanged"
    } (version ${constitutionResult.version})`,
  );

  const chrisBrainResult = await seedBrandMemoryIfChanged(prisma, "CHRIS_BRAIN", chrisBrain);
  console.log(
    `[seed] BrandMemory (CHRIS_BRAIN): ${
      chrisBrainResult.created ? "created" : "unchanged"
    } (version ${chrisBrainResult.version})`,
  );

  const seedEmail = process.env.SEED_USER_EMAIL;
  const seedPassword = process.env.SEED_USER_PASSWORD;
  if (!seedEmail || !seedPassword) {
    throw new Error(
      "SEED_USER_EMAIL and SEED_USER_PASSWORD must be set (see .env.example) to seed the dev user.",
    );
  }

  const passwordHash = await hashPassword(seedPassword);
  const user = await prisma.user.upsert({
    where: { email: seedEmail },
    create: { email: seedEmail, passwordHash, name: "Chris" },
    update: { passwordHash },
  });
  console.log(`[seed] User: ${user.email}`);

  await setFlag(prisma, {
    key: "autonomy.shadow_only",
    enabled: true,
    description:
      "Level 0 (Shadow) — AI recommends only, Chris runs the normal workflow. See /docs/PRODUCT_SPEC.md Autonomy levels.",
    actor: "seed-script",
    actorType: "SYSTEM",
  });
  console.log("[seed] FeatureFlag: autonomy.shadow_only = true");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
