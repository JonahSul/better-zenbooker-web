import {z} from 'zod/v3';
import {signPurposeProof,verifyPurposeProof} from './consent-proof';
export const experimentChoiceSchema=z.object({subject:z.string().uuid(),revision:z.number().int().positive(),granted:z.boolean(),expiresAt:z.number().int().positive()}).strict();
export type ExperimentChoice=z.infer<typeof experimentChoiceSchema>;
export async function signExperimentChoice(value:ExperimentChoice,secret:string){const payload=experimentChoiceSchema.parse(value);if(payload.expiresAt<=Date.now()||payload.expiresAt>Date.now()+30*86400000)throw new Error('Invalid consent expiry');return signPurposeProof(payload,secret,'experiment-choice:v2');}
export async function verifyExperimentChoice(value:string|null|undefined,secret:string|undefined,now=Date.now()):Promise<ExperimentChoice|null>{const parsed=experimentChoiceSchema.safeParse(await verifyPurposeProof(value,secret,'experiment-choice:v2'));return parsed.success&&parsed.data.expiresAt>now&&parsed.data.expiresAt<=now+30*86400000?parsed.data:null;}
