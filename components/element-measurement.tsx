'use client';
import {useEffect} from 'react';
import {startElementMeasurement} from '../lib/element-measurement-browser';
export default function ElementMeasurement(){useEffect(()=>startElementMeasurement(),[]);return null;}
