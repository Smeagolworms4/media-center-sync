export interface HealthCheck {
	name: string;
	ok: boolean;
	detail: string | null;
}

export interface Health {
	ok: boolean;
	version: string;
	uptimeSeconds: number;
	checks: HealthCheck[];
}
