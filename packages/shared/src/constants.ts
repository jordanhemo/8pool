// Units: millimetres and seconds.
export const TABLE_W = 2540;
export const TABLE_H = 1270;
export const BALL_R = 37.15; // 30% over regulation (28.575): bigger balls read better on small screens

export const DT = 1 / 240;
export const FRAME_EVERY = 4; // record one frame per 4 sim steps (60fps)
export const MAX_STEPS = 240 * 60; // hard cap on one shot's simulation

export const MAX_SPEED = 4000; // cue ball speed at power 1
export const FRICTION = 500; // constant deceleration, mm/s^2
export const REST_SPEED = 1; // below this a ball is stopped
export const BALL_RESTITUTION = 0.95;
export const CUSHION_RESTITUTION = 0.75;

export const CORNER_POCKET_R = 70;
export const SIDE_POCKET_R = 60;
export const POCKETS = [
  { x: 0, y: 0, r: CORNER_POCKET_R },
  { x: TABLE_W / 2, y: 0, r: SIDE_POCKET_R },
  { x: TABLE_W, y: 0, r: CORNER_POCKET_R },
  { x: 0, y: TABLE_H, r: CORNER_POCKET_R },
  { x: TABLE_W / 2, y: TABLE_H, r: SIDE_POCKET_R },
  { x: TABLE_W, y: TABLE_H, r: CORNER_POCKET_R },
] as const;

export const HEAD_SPOT = { x: TABLE_W / 4, y: TABLE_H / 2 };
export const FOOT_SPOT = { x: (TABLE_W * 3) / 4, y: TABLE_H / 2 };
export const FRAME_RATE = 1 / DT / FRAME_EVERY; // recorded frames per second (60)

// Cue ball spin ("english"). Fractions of the relevant speed that spin converts into extra motion.
export const SPIN_FOLLOW = 0.6; // follow/draw: added along the shot line on the cue ball's first contact
export const SPIN_RAIL = 0.35; // side spin: tangential kick on a cushion, per unit of normal speed
export const SPIN_RAIL_DECAY = 0.6; // side spin left after each cushion

// Jump shot: the cue ball leaves the cloth, so it passes over balls and pockets for a fixed time.
export const JUMP_STEPS = 84; // airtime in sim steps (0.35s)
export const JUMP_SPEED = 0.85; // fraction of the normal cue speed a jump shot keeps
