import {
  Box,
  Grid,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { links } from "./links";

interface Props {
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}

export default function Home({ setSelectedIndex }: Props) {
  const { pathname } = useLocation();

  useEffect(() => {
    setSelectedIndex(-1);
  }, [setSelectedIndex]);

  useEffect(() => {
    document.title = process.env.REACT_APP_NAME!;
  }, [pathname]);

  return (
    <Grid
      container
      spacing={0}
      direction="column"
      alignItems="center"
      justifyContent="center"
      sx={{ minHeight: `calc(100vh - 20px - 33px)` }}
    >
      <Grid item xs={3}>
        <Stack
          direction={{ xs: "column", sm: "row-reverse" }}
          spacing={2}
          sx={{ justifyContent: "center", alignItems: "center", height: "100%" }}
        >
          <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            {/* Use GitHub profile picture instead of favicon */}
            <img
              src="https://github.com/elvitigalalis.png"
              width="185rem"
              alt="GitHub profile"
              style={{ objectFit: 'contain', borderRadius: '50%', transform: 'scaleX(1)' }}
            />
          </Box>
          <Box>
            <Grid display="flex" justifyContent={{ xs: "center", sm: "flex-start" }}>
              <Typography variant="h3" sx={{ fontSize: { xs: '2.5rem', sm: '3.4rem' } }}>
                Lisul Elvitigala
              </Typography>
            </Grid>
            <Grid display="flex" justifyContent={{ xs: "center", sm: "flex-start" }}>
              <Typography variant="subtitle1" sx={{ fontSize: { xs: '1.25rem', sm: '1rem' } }} gutterBottom>
                Environmentalist & Computer Science Enthusiast
              </Typography>
            </Grid>
            <Grid display="flex" justifyContent={{ xs: "center", sm: "flex-start" }}>
              <Stack direction="row" spacing={0.4}>
                {links.map((link) => (
                  <Tooltip key={link.index} title={link.title} arrow>
                    <Link
                      target="_blank"
                      href={link.href}
                      underline="none"
                      color="inherit"
                    >
                      <IconButton color="inherit" sx={{ fontSize: '1.6rem' }}> {/* Adjust the font size here */}
                        {link.icon}
                      </IconButton>
                    </Link>
                  </Tooltip>
                ))}
              </Stack>
            </Grid>
          </Box>
        </Stack>
      </Grid>
    </Grid>
  );
}