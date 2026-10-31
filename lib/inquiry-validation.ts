import { denverToday } from './dates';
import { z } from 'zod/v3';
export const services:string[] = [];
export const areas:string[] = [];
export const sources = ['direct', 'google', 'other'] as const;
export const serviceNames: Record<string,string> = {};
export const inquiryInput = z.object({ submissionKey:z.string().uuid(), name:z.string().trim().min(1).max(80),contact:z.string().trim().min(5).max(160).refine(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^[+()\d\s.-]{7,30}$/.test(v)),service:z.string().trim().min(1).max(120),area:z.string().trim().min(1).max(160),source:z.enum(sources).default('direct'),note:z.string().trim().max(1000).default(''),preferredDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {const d=new Date(v+'T12:00:00Z'); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10)===v && v>denverToday() && v<=new Date(Date.now()+366*86400000).toISOString().slice(0,10);}) }).strict();
export const updateInput=z.object({id:z.string().uuid(),status:z.enum(['new','booked','completed']),revenueCents:z.number().int().min(0).max(100000000).nullable()}).strict();


