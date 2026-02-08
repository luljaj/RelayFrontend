import React, { useCallback, useEffect, useRef, useState } from 'react';
import Particles from 'react-tsparticles';
import type { Engine, ISourceOptions } from 'tsparticles-engine';
import { LockEntry } from '../hooks/useGraphData';

interface ParticleBurstManagerProps {
    locks: Record<string, LockEntry>;
    nodePositions: Record<string, { x: number; y: number }>;
    isDark: boolean;
}

interface ParticleBurst {
    id: string;
    x: number;
    y: number;
    color: string;
    timestamp: number;
}

const BURST_DURATION_MS = 1500;
const MAX_SIMULTANEOUS_BURSTS = 50;

export default function ParticleBurstManager({
    locks,
    nodePositions,
    isDark,
}: ParticleBurstManagerProps) {
    const [activeBursts, setActiveBursts] = useState<ParticleBurst[]>([]);
    const previousLocksRef = useRef<Record<string, LockEntry>>({});

    const particlesInit = useCallback(async (engine: Engine) => {
        // Particles library will auto-load required features
    }, []);

    // Detect lock releases and trigger particle bursts
    useEffect(() => {
        const previousLocks = previousLocksRef.current;
        const releasedLocks: { path: string; color: string }[] = [];

        // Find locks that were present before but are gone now
        for (const [path, lockEntry] of Object.entries(previousLocks)) {
            if (!locks[path]) {
                // Lock was released
                const color = agentTone(lockEntry.user_id);
                releasedLocks.push({ path, color });
            }
        }

        if (releasedLocks.length > 0) {
            const now = Date.now();
            const newBursts: ParticleBurst[] = [];

            for (const { path, color } of releasedLocks) {
                const position = nodePositions[path];
                if (position) {
                    newBursts.push({
                        id: `${path}-${now}`,
                        x: position.x,
                        y: position.y,
                        color,
                        timestamp: now,
                    });
                }
            }

            setActiveBursts((prev) => {
                // Add new bursts and enforce max limit
                const combined = [...prev, ...newBursts];
                if (combined.length > MAX_SIMULTANEOUS_BURSTS) {
                    // Remove oldest bursts to stay under limit
                    return combined.slice(combined.length - MAX_SIMULTANEOUS_BURSTS);
                }
                return combined;
            });
        }

        previousLocksRef.current = locks;
    }, [locks, nodePositions]);

    // Clean up expired bursts
    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            setActiveBursts((prev) => {
                const filtered = prev.filter((burst) => now - burst.timestamp < BURST_DURATION_MS);
                return filtered.length === prev.length ? prev : filtered;
            });
        }, 500);

        return () => clearInterval(interval);
    }, []);

    return (
        <>
            {activeBursts.map((burst) => (
                <ParticleBurstInstance
                    key={burst.id}
                    x={burst.x}
                    y={burst.y}
                    color={burst.color}
                    isDark={isDark}
                    particlesInit={particlesInit}
                />
            ))}
        </>
    );
}

interface ParticleBurstInstanceProps {
    x: number;
    y: number;
    color: string;
    isDark: boolean;
    particlesInit: (engine: Engine) => Promise<void>;
}

function ParticleBurstInstance({
    x,
    y,
    color,
    isDark,
    particlesInit,
}: ParticleBurstInstanceProps) {
    const options: ISourceOptions = {
        background: {
            opacity: 0,
        },
        fullScreen: {
            enable: false,
            zIndex: 1000,
        },
        particles: {
            number: {
                value: 15,
            },
            color: {
                value: color,
            },
            shape: {
                type: ['circle', 'square', 'triangle'],
            },
            opacity: {
                value: { min: 0, max: 0.8 },
                animation: {
                    enable: true,
                    speed: 1,
                    startValue: 'max',
                    destroy: 'min',
                },
            },
            size: {
                value: { min: 2, max: 6 },
            },
            move: {
                enable: true,
                speed: { min: 2, max: 4 },
                direction: 'none',
                outModes: {
                    default: 'destroy',
                },
                gravity: {
                    enable: true,
                    acceleration: 2,
                },
            },
            life: {
                duration: {
                    value: 1.5,
                },
            },
            rotate: {
                value: {
                    min: 0,
                    max: 360,
                },
                direction: 'random',
                animation: {
                    enable: true,
                    speed: 30,
                },
            },
        },
        emitters: {
            position: {
                x: 50,
                y: 50,
            },
            rate: {
                quantity: 15,
                delay: 0,
            },
            life: {
                count: 1,
                duration: 0.1,
            },
        },
        detectRetina: true,
    };

    return (
        <div
            style={{
                position: 'absolute',
                left: x,
                top: y,
                width: '100px',
                height: '100px',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                zIndex: 1000,
            }}
        >
            <Particles id={`particles-${x}-${y}`} init={particlesInit} options={options} />
        </div>
    );
}

function agentTone(seed: string): string {
    const tones = ['#f97316', '#06b6d4', '#f43f5e', '#22c55e', '#6366f1', '#eab308', '#14b8a6', '#fb7185'];
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return tones[hash % tones.length];
}
