// Display formatting shared across views.

export function age(iso: string): string
{
    const ms = Date.now() - Date.parse(iso);
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1)
    {
        return 'now';
    }
    if (minutes < 60)
    {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
    {
        return `${hours}h`;
    }
    return `${Math.floor(hours / 24)}d`;
}

export function usd(amount: number): string
{
    return `$${amount.toFixed(2)}`;
}

// Wall-clock rendering in the reader's own timezone — slicing an ISO string
// displays UTC, which disagrees with every other clock on the page.
export function clock(at: string | number): string
{
    return new Date(at).toTimeString().slice(0, 8);
}
