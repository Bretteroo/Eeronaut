import { createContext, useContext } from 'react'

/**
 * Opening the About Eeronaut dialog from anywhere inside the shell.
 *
 * The shell owns the dialog, because it keeps the version line it shows. A
 * page that offers About too, like the Eeronaut card in Settings, asks the
 * shell to open that one rather than mounting a second copy. Outside the
 * shell there is no dialog, and the default does nothing.
 */
export const AboutContext = createContext<() => void>(() => {})

export const useOpenAbout = () => useContext(AboutContext)
