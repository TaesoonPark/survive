import { describe, expect, it } from 'vitest';
import {
  BODY_PART_HIT_WEIGHTS,
  BODY_PART_IDS,
  BODY_PART_HEALTH_WEIGHT,
  armCapabilityMultiplier,
  bodyHealthFraction,
  createBody,
  createBodyPart,
  isFatalBody,
  legMobilityMultiplier,
  needsTreatment,
  totalBleeding,
  totalPain,
  worstInfection,
} from './body';

describe('body model', () => {
  it('creates a fully healthy body', () => {
    const body = createBody();
    expect(bodyHealthFraction(body)).toBeCloseTo(1, 6);
    expect(isFatalBody(body)).toBe(false);
    expect(needsTreatment(body)).toBe(false);
    expect(totalBleeding(body)).toBe(0);
    expect(totalPain(body)).toBe(0);
  });

  it('scales max health for tougher creatures', () => {
    const tough = createBody(2);
    expect(tough.parts.torso.maxHealth).toBe(200);
    expect(bodyHealthFraction(tough)).toBeCloseTo(1, 6);
  });

  it('has hit weights and health weights for every part', () => {
    for (const id of BODY_PART_IDS) {
      expect(BODY_PART_HIT_WEIGHTS[id]).toBeGreaterThan(0);
      expect(BODY_PART_HEALTH_WEIGHT[id]).toBeGreaterThan(0);
    }
    const totalHealthWeight = BODY_PART_IDS.reduce(
      (sum, id) => sum + BODY_PART_HEALTH_WEIGHT[id],
      0,
    );
    // The weights must sum to 1 or aggregate health would not reach 100%.
    expect(totalHealthWeight).toBeCloseTo(1, 6);
  });

  it('treats the torso as the likeliest target and the head as the rarest', () => {
    const weights = BODY_PART_IDS.map((id) => BODY_PART_HIT_WEIGHTS[id]);
    expect(BODY_PART_HIT_WEIGHTS.torso).toBe(Math.max(...weights));
    expect(BODY_PART_HIT_WEIGHTS.head).toBe(Math.min(...weights));
  });

  it('drops aggregate health proportionally to the part destroyed', () => {
    const body = createBody();
    body.parts.leftArm.health = 0;
    expect(bodyHealthFraction(body)).toBeCloseTo(1 - BODY_PART_HEALTH_WEIGHT.leftArm, 6);
  });

  it('is fatal when the head or the torso is destroyed, whatever the aggregate says', () => {
    const headshot = createBody();
    headshot.parts.head.health = 0;
    expect(isFatalBody(headshot)).toBe(true);
    // Aggregate health is still high, which is exactly why the special case exists.
    expect(bodyHealthFraction(headshot)).toBeGreaterThan(0.7);

    const gutted = createBody();
    gutted.parts.torso.health = 0;
    expect(isFatalBody(gutted)).toBe(true);
  });

  it('sums bleeding across parts and reports the worst infection', () => {
    const body = createBody();
    body.parts.leftLeg.bleeding = 1.5;
    body.parts.rightArm.bleeding = 0.5;
    body.parts.head.infection = 12;
    body.parts.torso.infection = 40;
    expect(totalBleeding(body)).toBeCloseTo(2, 6);
    expect(worstInfection(body)).toBe(40);
  });

  it('weights pain so a shattered leg outweighs a scraped forearm', () => {
    const legPain = createBody();
    legPain.parts.leftLeg.pain = 100;
    const armPain = createBody();
    armPain.parts.leftArm.pain = 100;
    expect(totalPain(legPain)).toBeGreaterThan(totalPain(armPain));
    expect(totalPain(legPain)).toBeLessThanOrEqual(100);
  });

  it('slows movement as legs are damaged, and a splint helps', () => {
    const healthy = createBody();
    expect(legMobilityMultiplier(healthy)).toBeCloseTo(1, 6);

    const hurt = createBody();
    hurt.parts.leftLeg.health = 0;
    const hurtSpeed = legMobilityMultiplier(hurt);
    expect(hurtSpeed).toBeLessThan(1);

    const broken = createBody();
    broken.parts.leftLeg.health = 0;
    broken.parts.leftLeg.fractured = true;
    const brokenSpeed = legMobilityMultiplier(broken);
    expect(brokenSpeed).toBeLessThan(hurtSpeed);

    const splinted = createBody();
    splinted.parts.leftLeg.health = 0;
    splinted.parts.leftLeg.fractured = true;
    splinted.parts.leftLeg.splinted = true;
    expect(legMobilityMultiplier(splinted)).toBeGreaterThan(brokenSpeed);
  });

  it('never cripples movement to a standstill', () => {
    const ruined = createBody();
    for (const id of BODY_PART_IDS) {
      ruined.parts[id].health = 0;
      ruined.parts[id].fractured = true;
    }
    expect(legMobilityMultiplier(ruined)).toBeGreaterThanOrEqual(0.25);
    expect(armCapabilityMultiplier(ruined)).toBeGreaterThanOrEqual(0.3);
  });

  it('uses the better arm for attack capability', () => {
    const oneGoodArm = createBody();
    oneGoodArm.parts.leftArm.health = 0;
    expect(armCapabilityMultiplier(oneGoodArm)).toBeCloseTo(1, 6);

    const bothHurt = createBody();
    bothHurt.parts.leftArm.health = 0;
    bothHurt.parts.rightArm.health = bothHurt.parts.rightArm.maxHealth / 2;
    expect(armCapabilityMultiplier(bothHurt)).toBeLessThan(1);
    expect(armCapabilityMultiplier(bothHurt)).toBeGreaterThan(0.3);
  });

  it('flags any untreated condition as needing treatment', () => {
    for (const mutate of [
      (b: ReturnType<typeof createBody>) => (b.parts.head.bleeding = 1),
      (b: ReturnType<typeof createBody>) => (b.parts.head.infection = 1),
      (b: ReturnType<typeof createBody>) => (b.parts.head.fractured = true),
      (b: ReturnType<typeof createBody>) => (b.parts.head.burned = 1),
      (b: ReturnType<typeof createBody>) => (b.parts.head.health -= 1),
    ]) {
      const body = createBody();
      mutate(body);
      expect(needsTreatment(body)).toBe(true);
    }
  });

  it('createBodyPart starts at full health with no conditions', () => {
    const part = createBodyPart(50);
    expect(part).toMatchObject({
      health: 50,
      maxHealth: 50,
      bleeding: 0,
      pain: 0,
      fractured: false,
      burned: 0,
      bitten: false,
      infection: 0,
      bandaged: false,
      splinted: false,
      stitched: false,
      disinfectedTicks: 0,
    });
  });

  it('stays JSON-serializable, as the architecture requires', () => {
    const body = createBody();
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });
});
